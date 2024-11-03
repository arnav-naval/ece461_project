import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDBDocClient = DynamoDBDocumentClient.from(dynamoDBClient);
const TABLE_NAME = "Packages";

/**
 * Searches packages using a regular expression on package names and README fields.
 * 
 * @param event - API Gateway event containing the regex in the request body
 * @returns APIGatewayProxyResult - List of matching packages or error message
 */
export const searchPackages = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const { RegEx } = JSON.parse(event.body);
    if (!RegEx) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid or missing RegEx field' }),
      };
    }

    // Attempt to compile the regex and catch any errors
    let regexPattern;
    try {
      regexPattern = new RegExp(RegEx, 'i'); // Case-insensitive
    } catch (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid regular expression' }),
      };
    }

    const params = {
      TableName: TABLE_NAME,
      ProjectionExpression: "PackageName, Version, README",
    };
    const result = await dynamoDBDocClient.send(new ScanCommand(params));
    const matchedPackages = (result.Items || []).filter(pkg =>
      regexPattern.test(pkg.PackageName) || (pkg.README && regexPattern.test(pkg.README))
    );

    if (matchedPackages.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No package found under this regex' }),
      };
    }

    const response = matchedPackages.map(pkg => ({
      Name: pkg.PackageName,
      Version: pkg.Version,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Error searching packages by RegEx:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
