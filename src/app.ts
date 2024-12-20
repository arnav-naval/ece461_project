import * as ms from "./metric_score.js";
import * as fs from "fs/promises";
import * as path from "path";
import express from "express";
import { info, debug, silent } from "./logger.js";

//Function to process a URL and calculate its Netscore
async function processUrl(url: string) {
  try {
    const startTime = Date.now();
    const score = await ms.netScore(url);
    const netScoreLatency = Date.now() - startTime; // overall Netscore Latency

    await info(`Processed URL: ${url}, Score: ${score}`);
    let ret = {
      URL: url,
      NetScore: score.NetScore,
      RampUp: score.RampUp,
      Correctness: score.Correctness,
      BusFactor: score.BusFactor,
      ResponsiveMaintainer: score.ResponsiveMaintainer,
      License: score.License,
      PinnedDependencies: score.PinnedDependencies,
      PRReview: score.PRReview,
      NetScore_Latency: netScoreLatency,
      RampUp_Latency: score.RampUp_Latency,
      Correctness_Latency: score.Correctness_Latency,
      BusFactor_Latency: score.BusFactor_Latency,
      ResponsiveMaintainer_Latency: score.ResponsiveMaintainer_Latency,
      License_Latency: score.License_Latency,
      PinnedDependencies_Latency: score.PinnedDependencies_Latency,
      PRReview_Latency: score.PRReview_Latency,
    };
    return ret;
  } catch (err) {
    await info(`Error processing ${url}: ${err.message}`);
    return { URL: url, NetScore: -1 };
  }
}

//Main function to process URLs from a file or command line arguments
export async function main(testFile?: string) {
  await info("Program started");
  // check if filename provided
  if (process.argv.length < 3 && !testFile) {
    await info("Usage: npm start <filename>");
    process.exit(1);
  }

  const filename = testFile ? testFile : process.argv[2];
  let ndjsonOutput;

  try {
    // read file content
    const filePath = path.resolve(filename);
    const fileContent = await fs.readFile(filePath, "utf-8");

    // split file content by newline and filter empty lines
    const urls = fileContent.split("\n").filter((line) => line.trim() !== "");
    await info(`Processing ${urls.length} URLs from file: ${filename}`);

    // Process all URLs in parallel (concurrently)
    const results = await Promise.all(urls.map((url) => processUrl(url)));

    // Prepare NDJSON output
    ndjsonOutput = results.map((result) => JSON.stringify(result)).join("\n");

    // print output to console
    console.log(ndjsonOutput);
  } catch (err) {
    await info(`Error reading file: ${filename}. Error: ${err.message}`);
    process.exit(1);
  } finally {
    if (testFile) {
      return ndjsonOutput;
    } else {
      await info("Program ended");
      process.exit(0);
    }
  }
}


// Only call main if this file is being run directly outside of Jasmine
if (
  !process.argv[1].endsWith("jasmine.js") &&
  !process.argv[1].endsWith("jasmine")
) {
  main();
}
