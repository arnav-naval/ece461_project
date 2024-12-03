//package controller to define functionality for routes for uploading and downloading packages
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { netScore } from '../metric_score.js';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';

//initialize S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

//initialize dynamoDB client
const dynamoDb = new DynamoDBClient({
  region: process.env.AWS_REGION,
})

//Interface for the request body of PackageData
export interface PackageData {
  Content?: string;
  URL?: string;
  JSProgram: string;
}

//Interface for the metadata of PackageData
interface PackageMetadata {
  Name: string;
  Version: string;
  ID: string;
}

//Interface for the response body of PackageData
interface PackageResponse {
  metadata: PackageMetadata;
  data: PackageData;
}

//Function to generate a unique package id
export const generatePackageId = (name: string, version: string): string => {
  return createHash('sha256').update(`${name}-${version}`).digest('hex');
};

//Getting package zip file from npm or github url
export const getGithubUrlFromUrl = async (url: string): Promise<string> => {
  //Asssume we are given a valid npm or github url, return the github url
  let githubUrl = url;
  if (url.includes("npmjs.com")) {
    try {
      // Extract the package name from the URL
      const packagePath = url.split("npmjs.com/package/")[1];
      if (!packagePath) {
        throw new Error("Invalid npm URL");
      }

      const apiUrl = `https://registry.npmjs.org/${packagePath}`;
      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`npm API error: ${response.statusText}`);
      }
      const repoURL = await response.json();

      const repo: string = repoURL ? repoURL.repository.url : null;

      if (!repo) {
        console.info("No repository URL found in npm data");
        throw new Error("No repository URL found in npm data");
      }

      // Update to Github URL
      githubUrl = repo
        .replace("git+", "")
        .replace("git:", "https:")
        .replace(".git", "");
    } catch (err) {
      console.info("Error fetching npm data");
      throw new Error(`Error fetching npm data: ${err.message}`);
    }
  }

  //Return the github url
  return githubUrl;
};

//Function to get the zip file from the github url
export const getZipFromGithubUrl = async (githubUrl: string): Promise<AdmZip> => {
  try {
    // Get repo info to find the default branch name
    const apiUrl = githubUrl
      .replace('github.com', 'api.github.com/repos')
      .replace(/\/$/, '');
    
    const repoResponse = await fetch(apiUrl);
    if (!repoResponse.ok) {
      throw new Error('Failed to fetch repository info');
    }
    
    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch;
    
    // Download zip and convert directly to buffer
    const zipUrl = `${githubUrl}/archive/refs/heads/${defaultBranch}.zip`;
    const zipResponse = await fetch(zipUrl);
    if (!zipResponse.ok) {
      throw new Error('Failed to download zip file');
    }
    //Convert the zip response to a buffer
    const buffer = Buffer.from(await zipResponse.arrayBuffer());
    //Create an AdmZip object from the buffer
    return new AdmZip(buffer);
  } catch (error) {
    throw new Error(`Failed to download GitHub repository: ${error.message}`);
  }
};


//Function to upload a base64 encoded zip file to S3
export const uploadBase64ZipToS3 = async (base64String: string): Promise<void> => {
  try {
    //Decode base64 string to buffer
    const buffer = Buffer.from(base64String, 'base64');

    //Create a zip object from the buffer
    const zip = new AdmZip(buffer);

    //Fetch the name and version from the package.json
    const { name, version } = fetchPackageJson(zip);

    //Generate the S3 key
    //const s3Key = generateS3Key(name, version);
    const packageId = generatePackageId(name, version);
    //Set up s3 upload parameters
    const putObjectParams = {
      Bucket: process.env.BUCKET_NAME,
      Key: `${packageId}.zip`, //only adding zip to key changes file type in S3 bucket
      Body: buffer,
      Metadata: {
        Name: name,
        Version: version,
      }
    };

    //Upload the buffer to S3
    const command = new PutObjectCommand(putObjectParams);
    await s3.send(command);
    console.info(`Uploaded base64 encoded zip file to S3`);
  } catch (err) {
    console.error(`Error uploading base64 encoded zip file to S3: ${err.message}`);
    throw err;
  }
  
};

//Function to fetch the package.json from the zip file and throw an error if it is not found  
export const fetchPackageJson = (zip: AdmZip): { name: string, version: string } => {
  //Get all entries from the zip file
  const zipEntries = zip.getEntries();

  //First try to find root-level package.json
  let packageJsonEntry = zipEntries.find(entry => entry.entryName === 'package.json');

  //If not found at root, look for any package.json
  if (!packageJsonEntry) {
    packageJsonEntry = zipEntries.find(entry => entry.entryName.endsWith('package.json'));
  }

  //Throw an error if package.json is not found
  if (!packageJsonEntry) {
    throw new Error('Package.json not found in the zip file');
  }
 
  //Get the content of the package.json entry
  const packageJsonContent = packageJsonEntry.getData().toString('utf8');
  //Return the parsed package.json content
  const packageJson = JSON.parse(packageJsonContent);

  //If version is not present, sei it to "1.0.0"
  let version;
  if (!packageJson.version) {
    version = "1.0.0";
  } else {
    version = packageJson.version;
  }

  //If name is not present, throw an error
  if (!packageJson.name) {
    throw new Error('Name is not present in the package.json file');
  }

  //Return the name and version
  return {
    name: packageJson.name,
    version: version,
  };
};

//Function to process the request body of URL, Content, and JSProgram
export const validateRequestBody = (body: PackageData): { isValid: boolean, error?: string } => {
  //Check if all required fields are presen
  if (!body.URL && !body.Content && !body.JSProgram) {
    return {
      isValid: false,
      error: 'Missing required fields: URL, Content, or JSProgram',
    };
  }

   // Check if either URL or Content is provided
   if (!body.URL && !body.Content) {
    return {
      isValid: false,
      error: 'Missing required fields: Must provide either URL or Content',
    };
  }

  //Check if JSProgram is provided
  if (!body.JSProgram) {
    return {
      isValid: false,
      error: 'Missing required fields: JSProgram',
    };
  }

  // Check if both URL and Content are provided (not allowed)
  if (body.URL && body.Content) {
    return {
      isValid: false,
      error: 'Cannot provide both URL and Content fields',
    };
  }

  //If all checks pass, return true
  return {
    isValid: true,
  }; 
};

//Function to upload the zip file to S3 from a github url
export const uploadURLZipToS3 = async (githubUrl: string): Promise<void> => {
  try {
    //Get the github url from the URL provided
    const url = await getGithubUrlFromUrl(githubUrl);
    
    //Get the zip file from the github url
    const zip = await getZipFromGithubUrl(url);
    
    //Fetch the name and version from the package.json
    const { name, version } = fetchPackageJson(zip);
    
    //Generate the S3 key
    const packageId = generatePackageId(name, version);

    //Set up s3 upload parameters
    const putObjectParams = {
      Bucket: process.env.BUCKET_NAME,
      Key: `${packageId}.zip`,
      Body: zip, //removed .toBuffer() since zip is already a buffer
      Metadata: {
        Name: name,
        Version: version,
      }
    };

    //Upload the buffer to S3
    const command = new PutObjectCommand(putObjectParams);
    await s3.send(command);
    console.info(`Successfully uploaded package ${name}@${version} to S3`);
  } catch (error) {
    const message = error.message || 'Unknown error';
    console.error(`Error uploading URL package to S3: ${error.message}`);
    throw new Error(`Failed to upload package from URL: ${error.message}`);
  };
};

export const packageExists = async (packageId: string): Promise<boolean> => {
  try {
    //Check if package already exists in S3 bucket
    const command = new HeadObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: `${packageId}.zip`,
    });
    await s3.send(command);
    return true; //Object exists
  } catch (error) {
    if (error.name === 'NotFound') {
      return false; //Object does not exist
    }
    throw error;
  }
};

// function to upload a package to S3
export const uploadPackageToS3 = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
      const requestBody = JSON.parse(event.body || '{}');
      const validation = validateRequestBody(requestBody);

      // Validate request body
      if (!validation.isValid) {
          return {
              statusCode: 400,
              body: JSON.stringify({ error: validation.error }),
          };
      }

      const { Content, URL, JSProgram } = requestBody;
      let metadata;

      // Handle Content case
      if (Content) {
          const zipBuffer = Buffer.from(Content, 'base64');

          try {
              const zip = new AdmZip(zipBuffer);
              const packageJson = PackageController.fetchPackageJson(zip);
              const { name, version } = packageJson;

              if (!name || !version) {
                  return {
                      statusCode: 400,
                      body: JSON.stringify({ error: 'Invalid package.json: missing name or version' }),
                  };
              }

              metadata = { Name: name, Version: version };
              await PackageController.uploadBase64ZipToS3(Content);
          } catch (err) {
              return {
                  statusCode: 400,
                  body: JSON.stringify({ error: 'Invalid base64 content or zip format' }),
              };
          }
      }

      // Handle URL case
      if (URL) {
          try {
              await PackageController.uploadURLZipToS3(URL);
              const zip = new AdmZip(); // Replace with logic for fetching ZIP from URL
              const packageJson = PackageController.fetchPackageJson(zip);
              const { name, version } = packageJson;

              if (!name || !version) {
                  return {
                      statusCode: 400,
                      body: JSON.stringify({ error: 'Invalid package.json: missing name or version' }),
                  };
              }

              metadata = { Name: name, Version: version };
          } catch (err) {
              return {
                  statusCode: 500,
                  body: JSON.stringify({ error: 'Error processing package upload' }),
              };
          }
      }

      // Success response
      return {
          statusCode: 201,
          body: JSON.stringify({
              metadata,
              message: 'Package uploaded successfully',
          }),
      };
  } catch (error) {
      return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Internal server error' }),
      };
  }
};

//Function to handle the base64 upload
export const handleBase64Upload = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Validate request body
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const { base64Content, jsprogram } = JSON.parse(event.body);

    if (!base64Content || !jsprogram) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: base64Content or jsprogram' }),
      };
    }

    // Parse base64 content
    let zip: AdmZip;
    try {
      const zipBuffer = Buffer.from(base64Content, 'base64');
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid base64 content' }),
      };
    }

    // Check for package.json
    const zipEntries = zip.getEntries();
    const packageJsonEntry = zipEntries.find(entry => entry.entryName === 'package.json');

    if (!packageJsonEntry) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Package.json not found in the zip file' }),
      };
    }

    // Parse and validate package.json
    let metadata;
    try {
      const packageJson = JSON.parse(packageJsonEntry.getData().toString('utf-8'));
      const { name, version } = packageJson;

      if (!name || !version) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid package.json: missing name or version' }),
        };
      }

      metadata = { name, version };
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid package.json format' }),
      };
    }

    // Upload to S3
    await uploadBase64ZipToS3(base64Content);

    // Success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Package uploaded successfully',
        metadata,
      }),
    };
  } catch (error) {
    console.error('Error handling base64 upload:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

//Function to validate the score and ensure all scores are above 0.5
export const validateScore = (score: any): boolean => {
  const lim = 0;
  return score.BusFactor >= lim && score.Correctness >= lim && score.RampUp >= lim && score.ResponsiveMaintainer >= lim && score.License >= lim && score.PinnedDependencies >= lim && score.PRReview >= lim;
};

//Function to check the package rating and return the rating as a json object
export const checkPackageRating = async (requestBody: PackageData): Promise<any> => {
  //if requestBody.URL is provided, check the rating of the package from the url else check from requestBody.Content
  try {
    if (requestBody.URL) {
      //check the rating of the package from the url
      const url = await getGithubUrlFromUrl(requestBody.URL);
      console.log('Resolved GitHub URL:', url); // Debug log

      const score = await netScore(url);
      console.log('Score from netScore:', score); // Debug log

      const validScore = validateScore(score);
      console.log('Is the score valid:', validScore); // Debug log
      if (!validScore) {
        return {
          statusCode: 424,
          body: JSON.stringify({ error: 'Package is not uploaded due to the disqualified rating' })
        };
      }
      return score;
    } else {
      //check the rating of the package from the requestBody.Content
      const tempBuffer = Buffer.from(requestBody.Content, 'base64');
      const zip = new AdmZip(tempBuffer);
      //get github url from zip file
      //run package rating check on url and return score
      
    }
  } catch (error) {
    console.error('Error checking package rating:', error);
    return {
      statusCode: 424,
      body: JSON.stringify({ error: 'Error checking package rating, package could not be uploaded' })
    };
  }
};

//Function to upload package scores and S3 data to dynamoDB database
const uploadPackageMetadataToDynamoDB = async (scores: any, packageId: string): Promise<void> => {
  try {
    //Create the item to be uploaded to dynamoDB
    const item = {
      packageId: packageId,
      timestamp: new Date().toISOString(),
      scores: {
        netScore: scores.netScore,
        BusFactor: scores.BusFactor,
        Correctness: scores.Correctness,
        RampUp: scores.RampUp,
        ResponsiveMaintainer: scores.ResponsiveMaintainer,
        License: scores.License,
        PinnedDependencies: scores.PinnedDependencies,
        PRReview: scores.PRReview,
      }
    };

    //Create params for DynamDB PutItemCommand
    const params = {
      TableName: process.env.SCORES_TABLE_NAME,
      Item: marshall(item),
    };

    //Upload the item to dynamoDB
    const command = new PutItemCommand(params);
    await dynamoDb.send(command);
    console.info(`Successfully uploaded package ${packageId} scores to dynamoDB`);
  } catch (error) {
    console.error('Error uploading package scores to dynamoDB:', error);
    throw new Error('Error uploading package scores to dynamoDB');
  }
};

export const PackageController = {
  uploadBase64ZipToS3,
  getGithubUrlFromUrl,
  checkPackageRating,
  uploadPackageToS3,
  uploadURLZipToS3,
  generatePackageId,
  fetchPackageJson
};

