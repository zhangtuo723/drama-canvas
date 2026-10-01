import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, link, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";

const run = promisify(execFile);
const types = {
  png: { mime: "image/png", extension: ".png", extensions: [".png"] },
  jpeg: {
    mime: "image/jpeg",
    extension: ".jpg",
    extensions: [".jpg", ".jpeg"],
  },
  webp: { mime: "image/webp", extension: ".webp", extensions: [".webp"] },
  gif: { mime: "image/gif", extension: ".gif", extensions: [".gif"] },
  avif: { mime: "image/avif", extension: ".avif", extensions: [".avif"] },
  mp4: { mime: "video/mp4", extension: ".mp4", extensions: [".mp4"] },
  mov: { mime: "video/quicktime", extension: ".mov", extensions: [".mov"] },
  webm: { mime: "video/webm", extension: ".webm", extensions: [".webm"] },
};

function invalid(message, code = "INVALID_MEDIA") {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

// The signature selects a decoder; the decoder must still validate the content.
function identify(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "gif";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && bytes.length >= 16) {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize < 16 || boxSize > bytes.length) return undefined;
    const brands = [bytes.toString("ascii", 8, 12)];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4)
      brands.push(bytes.toString("ascii", offset, offset + 4));
    if (brands.some((brand) => ["avif", "avis"].includes(brand))) return "avif";
    if (brands.includes("qt  ")) return "mov";
    if (
      brands.some((brand) =>
        /^(iso[0-9m]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand),
      )
    )
      return "mp4";
  }
  // Older QuickTime files can start with a movie/data atom without ftyp.
  if (["moov", "mdat", "wide"].includes(bytes.toString("ascii", 4, 8)))
    return "mov";
  if (bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) {
    const marker = bytes.indexOf(Buffer.from([0x42, 0x82]), 4);
    if (
      marker >= 0 &&
      bytes[marker + 2] === 0x84 &&
      bytes.toString("ascii", marker + 3, marker + 7) === "webm"
    )
      return "webm";
  }
  return undefined;
}

async function probeVideo(file, type) {
  let binary;
  try {
    binary = (await import("@ffprobe-installer/ffprobe")).default.path;
  } catch {
    throw invalid(
      "当前平台没有可用的视频校验工具，请安装 @ffprobe-installer/ffprobe 后重试",
      "VIDEO_PROBE_UNAVAILABLE",
    );
  }
  let output;
  try {
    output = await run(
      binary,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES")
      throw invalid(
        "视频校验工具不可执行，请重新安装 @ffprobe-installer/ffprobe",
        "VIDEO_PROBE_UNAVAILABLE",
      );
    if (error.killed)
      throw invalid(
        "视频校验超过 120 秒，请缩短视频后重试",
        "VIDEO_PROBE_TIMEOUT",
      );
    throw invalid("视频文件损坏，或编码不受当前校验工具支持");
  }
  if (output.stderr.trim())
    throw invalid("视频解码失败：文件损坏或编码不受支持");
  const info = JSON.parse(output.stdout);
  const video = info.streams?.find(
    (stream) =>
      stream.codec_type === "video" && Number(stream.nb_read_frames) > 0,
  );
  const format = info.format?.format_name || "";
  if (
    !video ||
    !Number.isFinite(video.width) ||
    !Number.isFinite(video.height) ||
    video.width <= 0 ||
    video.height <= 0 ||
    (type === "webm" ? !format.includes("webm") : !format.includes("mov"))
  )
    throw invalid("不是可解码的有效视频文件");
  const duration = Number(info.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw invalid(
      "无法读取视频时长，请转换为带完整时长信息的 MP4/WebM/MOV 后重试",
    );
  const rotation = Number(
    video.side_data_list?.find((entry) => entry.rotation !== undefined)
      ?.rotation ??
      video.tags?.rotate ??
      0,
  );
  const rotated = Math.abs(rotation) % 180 === 90;
  return {
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    duration,
  };
}

// Atomic, no-clobber publication: unlike rename, link never replaces an existing
// content-addressed original when two imports finish at the same time.
async function publish(temp, destination) {
  try {
    await link(temp, destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

/** Stream an original into a project, validate it, and return asset metadata. */
export async function importMedia(dir, file, name = path.basename(file)) {
  const extension = path.extname(name).toLowerCase();
  if (!Object.values(types).some((type) => type.extensions.includes(extension)))
    throw invalid(
      "支持 PNG/JPG/WebP/GIF/AVIF/MP4/WebM/MOV",
      "UNSUPPORTED_MEDIA_FORMAT",
    );
  if (!(await stat(file)).isFile()) throw invalid("素材路径必须是文件");
  const assetsDir = path.join(path.resolve(dir), "assets");
  const thumbnailsDir = path.join(path.resolve(dir), "thumbnails");
  await mkdir(assetsDir, { recursive: true });
  const token = randomUUID();
  const temporary = path.join(assetsDir, `.import-${token}.tmp`);
  const temporaryThumbnail = path.join(thumbnailsDir, `.import-${token}.webp`);
  const hash = createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await pipeline(
      createReadStream(file),
      new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          size += chunk.length;
          if (head.length < 65_536)
            head = Buffer.concat([
              head,
              chunk.subarray(0, 65_536 - head.length),
            ]);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: "wx" }),
    );
    const format = identify(head);
    const type = types[format];
    if (!type)
      throw invalid("无法识别素材真实格式，文件可能损坏或并非图片/视频");
    if (!type.extensions.includes(extension))
      throw invalid(
        `文件内容为 ${format.toUpperCase()}，与扩展名 ${extension} 不匹配`,
        "MEDIA_FORMAT_MISMATCH",
      );
    const id = "asset_" + hash.digest("hex").slice(0, 24);
    const asset = {
      id,
      name,
      mime: type.mime,
      size,
      file: id + type.extension,
      url: "/assets/" + id,
    };
    if (type.mime.startsWith("image/")) {
      await mkdir(thumbnailsDir, { recursive: true });
      try {
        const options = {
          failOn: "warning",
          limitInputPixels: 100_000_000,
          animated: false,
        };
        const metadata = await sharp(temporary, options).metadata();
        if (!metadata.width || !metadata.height)
          throw new Error("Missing dimensions");
        const rotated = [5, 6, 7, 8].includes(metadata.orientation);
        asset.width = rotated ? metadata.height : metadata.width;
        asset.height = rotated ? metadata.width : metadata.height;
        await sharp(temporary, options)
          .rotate()
          .resize({
            width: 480,
            height: 480,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toFile(temporaryThumbnail);
      } catch {
        throw invalid("图片解码失败：文件损坏、编码不受支持或超过 1 亿像素");
      }
      asset.thumbnail = id + ".webp";
      asset.thumbnailUrl = "/thumbnails/" + id;
      await publish(
        temporaryThumbnail,
        path.join(thumbnailsDir, asset.thumbnail),
      );
    } else {
      Object.assign(asset, await probeVideo(temporary, format));
    }
    await publish(temporary, path.join(assetsDir, asset.file));
    return asset;
  } finally {
    await Promise.all(
      [temporary, temporaryThumbnail].map((item) =>
        unlink(item).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        }),
      ),
    );
  }
}
