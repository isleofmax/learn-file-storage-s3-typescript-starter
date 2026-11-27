import { respondWithJSON } from "./json";

import { rm } from "fs/promises";
import { type ApiConfig } from "../config";
import { type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { mediaTypeToExt } from "./assets";
import crypto from "crypto";
import path from "path";
import { tmpdir } from "os";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("User Forbidden: user not authorized");
  }

  const data = await req.formData();
  const parsedData = data.get("video");
  if (!(parsedData instanceof File)) {
    throw new BadRequestError("Bad request: error uploading file");
  }

  if (parsedData.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Bad request: file too large");
  }

  const mediaType = parsedData.type;
  if (!mediaType) {
    throw new BadRequestError("Bad request: missing Content-Type");
  }

  const ext = mediaTypeToExt(mediaType);
  if (ext !== "mp4") {
    throw new BadRequestError("Bad request: wrong Content-Type");
  }

  const tempFileName: string = crypto.randomBytes(32).toString("base64url") + "." + ext;
  const pathFile = path.join(tmpdir(), tempFileName);
  Bun.write(pathFile, parsedData);

  const aspectRatio = await getVideoAspectRatio(pathFile);
  const processedFilePath = await processVideoForFastStart(pathFile);
  const keyFile = `${aspectRatio}/${videoId}.mp4`;

  const s3File: S3File = cfg.s3Client.file(keyFile);
  await s3File.write(Bun.file(processedFilePath), { type: mediaType });
  
  video.videoURL = `${cfg.s3CfDistribution.replace(/\/$/, "")}/${keyFile}`;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(pathFile, { force: true }),
    rm(`${pathFile}.processed.mp4`, { force: true }),
  ]);

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  let ratio = "";
  if (width === Math.floor(16 * (height / 9))) {
    ratio = "landscape";
  } else if (height === Math.floor(16 * (width / 9))) {
    ratio = "portrait"
  } else {
    ratio = "other";
  }

  return ratio;
}

export async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed.mp4`;

  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" },
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}
