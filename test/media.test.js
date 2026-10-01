import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { importMedia } from "../src/media.js";

async function project(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "canvas-media-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const image = () =>
  sharp({
    create: { width: 1000, height: 600, channels: 3, background: "#308959" },
  });

test("image import validates content, preserves originals, and makes bounded thumbnails", async (t) => {
  const dir = await project(t);
  for (const format of ["png", "jpeg", "webp", "gif", "avif"]) {
    const file = path.join(dir, "source." + format);
    await image().toFormat(format).toFile(file);
    const result = await importMedia(dir, file);
    assert.equal(result.mime, "image/" + format);
    assert.equal(result.width, 1000);
    assert.equal(result.height, 600);
    assert.equal(result.size, (await stat(file)).size);
    assert.deepEqual(
      await readFile(path.join(dir, "assets", result.file)),
      await readFile(file),
    );
    const thumbnail = await sharp(
      path.join(dir, "thumbnails", result.thumbnail),
    ).metadata();
    assert.equal(thumbnail.format, "webp");
    assert.equal(thumbnail.width, 480);
    assert.equal(thumbnail.height, 288);
    assert.equal(result.thumbnailUrl, "/thumbnails/" + result.id);
  }
  assert.ok(
    (await readdir(path.join(dir, "assets"))).every(
      (file) => !file.startsWith(".import-"),
    ),
  );
});

test("EXIF rotation is included in dimensions and applied to the thumbnail", async (t) => {
  const dir = await project(t);
  const file = path.join(dir, "rotated.jpg");
  await image().withMetadata({ orientation: 6 }).jpeg().toFile(file);
  const result = await importMedia(dir, file);
  assert.equal(result.width, 600);
  assert.equal(result.height, 1000);
  const thumbnail = await sharp(
    path.join(dir, "thumbnails", result.thumbnail),
  ).metadata();
  assert.equal(thumbnail.width, 288);
  assert.equal(thumbnail.height, 480);
  assert.ok(!thumbnail.orientation || thumbnail.orientation === 1);
});

test("content deduplication uses canonical extensions and does not replace existing originals", async (t) => {
  const dir = await project(t);
  const file = path.join(dir, "source.jpeg");
  await image().jpeg().toFile(file);
  const first = await importMedia(dir, file);
  const before = await stat(path.join(dir, "assets", first.file));
  const others = await Promise.all([
    importMedia(dir, file, "alias.jpg"),
    importMedia(dir, file, "alias.jpeg"),
  ]);
  for (const result of others) {
    assert.equal(result.id, first.id);
    assert.equal(result.file, first.file);
  }
  const after = await stat(path.join(dir, "assets", first.file));
  assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal((await readdir(path.join(dir, "assets"))).length, 1);
  assert.equal((await readdir(path.join(dir, "thumbnails"))).length, 1);
});

test("fake, truncated, and extension-mismatched images leave no import temporary files", async (t) => {
  const dir = await project(t);
  const file = path.join(dir, "broken.png");
  await writeFile(file, "this is not an image");
  await assert.rejects(importMedia(dir, file), /真实格式/);
  await writeFile(file, (await image().png().toBuffer()).subarray(0, 40));
  await assert.rejects(importMedia(dir, file), /图片解码失败/);
  await image().jpeg().toFile(file);
  await assert.rejects(
    importMedia(dir, file),
    (error) => error.code === "MEDIA_FORMAT_MISMATCH",
  );
  assert.deepEqual(await readdir(path.join(dir, "assets")), []);
  assert.deepEqual(await readdir(path.join(dir, "thumbnails")), []);
});

// Self-contained 16 x 12, 1-second synthetic clips generated with OpenCV/FFmpeg.
// No network, external encoder, or personal project media is needed by the tests.
const clips = {
  mp4: "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAALm1kYXQAAAGzABAHAAABthYHGXbYKIMjAAABswAQBwAAAbYeBxpNsF4GJwAAAy9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACWnRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAAAwAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAdJtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAF9bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABPXN0YmwAAADZc3RzZAAAAAAAAAABAAAAyW1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAMAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAABfZXNkcwAAAAADgICATgABAASAgIBAIBEAAAAAAAMAAAABMAWAgIAuAAABsAEAAAG1iRMAAAEAAAABIADEjYgAFQCEAZRjAAABskxhdmM2MC4zLjEwMAaAgIABAgAAABRidHJ0AAAAAAAAAwAAAAEwAAAAGHN0dHMAAAAAAAAAAQAAAAIAACAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABRzdHN6AAAAAAAAABMAAAACAAAAFHN0Y28AAAAAAAAAAQAAACwAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYwLjMuMTAw",
  mov: "AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAC5tZGF0AAABswAQBwAAAbYWBxl22CiDIwAAAbMAEAcAAAG2HgcaTbBeBicAAAMGbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAnJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAMAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHqbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQAB//wAAAAAALWhkbHIAAAAAbWhscnZpZGUAAAAAAAAAAAAAAAAMVmlkZW9IYW5kbGVyAAABlW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAAAAAAAAAAAAAAC0RhdGFIYW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABKXN0YmwAAADFc3RzZAAAAAAAAAABAAAAtW1wNHYAAAAAAAAAAQAAAABGRk1QAAACAAAAAgAAEAAMAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAABfZXNkcwAAAAADgICATgABAASAgIBAIBEAAAAAAAMAAAABMAWAgIAuAAABsAEAAAG1iRMAAAEAAAABIADEjYgAFQCEAZRjAAABskxhdmM2MC4zLjEwMAaAgIABAgAAABhzdHRzAAAAAAAAAAEAAAACAAAgAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAUc3RzegAAAAAAAAATAAAAAgAAABRzdGNvAAAAAAAAAAEAAAAkAAAAIHVkdGEAAAAYqXN3cgAMVcRMYXZmNjAuMy4xMDA=",
  webm: "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH7EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEZTbuMU6uEHFO7a1OsggHl7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjAuMy4xMDBXQYxMYXZmNjAuMy4xMDBEiYhAj0AAAAAAABZUrmu+rgEAAAAAAAA114EBc8WINg9C+iK0PzycgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4IawgRC6gQwSVMNn2HNzn2PAgGfImUWjh0VOQ09ERVJEh4xMYXZmNjAuMy4xMDBzc7NjwItjxYg2D0L6IrQ/PGfIokWjiERVUkFUSU9ORIeUMDA6MDA6MDEuMDAwMDAwMDAwAAAfQ7Z16ueBAKO8gQAAgPACAJ0BKhAADAAARwiFhYiFhIgBohATrVAfwB/QEGpvcP7rjl/+zEl3IhH/sxT/8mvDXa9/5JwAo6eBAfQA0QEAARANEADAAYFBf6ABAAD+1jH/5Z2KypVl3GcORL4SEAAcU7trkbuPs4EAt4r3gQHxggF28IED",
};

test("real MP4/MOV/WebM clips are decoded and return video dimensions and duration", async (t) => {
  const dir = await project(t);
  for (const [extension, encoded] of Object.entries(clips)) {
    const file = path.join(dir, "tiny." + extension);
    await writeFile(file, Buffer.from(encoded, "base64"));
    const asset = await importMedia(dir, file);
    assert.equal(asset.width, 16);
    assert.equal(asset.height, 12);
    assert.equal(asset.duration, 1);
    assert.equal(
      asset.mime,
      extension === "mov" ? "video/quicktime" : "video/" + extension,
    );
    assert.equal(asset.thumbnail, undefined);
  }
});

test("truncated video and misleading extensions are rejected without publishing files", async (t) => {
  const dir = await project(t);
  const file = path.join(dir, "broken.mp4");
  await writeFile(file, Buffer.from(clips.mp4, "base64").subarray(0, 82));
  await assert.rejects(importMedia(dir, file), /视频文件损坏/);
  await writeFile(file, Buffer.from(clips.mp4, "base64"));
  await assert.rejects(
    importMedia(dir, file, "incorrect.mov"),
    (error) => error.code === "MEDIA_FORMAT_MISMATCH",
  );
  assert.deepEqual(await readdir(path.join(dir, "assets")), []);
});
