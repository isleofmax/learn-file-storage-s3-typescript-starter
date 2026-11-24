import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { mediaTypeToExt } from "./assets";
import path from "node:path";

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
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
  const parsedData = data.get("thumbnail");
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

  const bytes: ArrayBuffer = await parsedData.arrayBuffer();
  if (!bytes) {
    throw new Error("Error reading file data");
  }

  // find extension
  const ext = mediaTypeToExt(mediaType);
  if (ext !== "jpeg" && ext !== "png") {
    throw new BadRequestError("Bad request: wrong Content-Type");
  }
  const pathFile = path.join(cfg.assetsRoot,`${videoId}.${ext}`);
  Bun.write(pathFile, bytes);

  const newUrl = `http://localhost:${cfg.port}/assets/${videoId}.${ext}`;
  video.thumbnailURL = newUrl;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
