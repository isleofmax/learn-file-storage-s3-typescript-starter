import { respondWithJSON } from "./json";

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

  const bytes: ArrayBuffer = await parsedData.arrayBuffer();
  if (!bytes) {
    throw new Error("Error reading file data");
  }

  const tempFileName: string = crypto.randomBytes(32).toString("base64url") + "." + ext;
  const pathFile = path.join(tmpdir(), tempFileName);
  Bun.write(pathFile, bytes);

  const keyFile = `${videoId}.mp4`;
  const s3File: S3File = cfg.s3Client.file(keyFile);

                //https://tubely-556677.s3.eu-north-1.amazonaws.com/boots-image-horizontal.png
  const newUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${keyFile}`;
  console.log(newUrl),
  
  await s3File.write(Bun.file(pathFile), { type: mediaType });
  
  video.videoURL = newUrl;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, newUrl);
}
