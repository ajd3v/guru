import { open, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/** Keep file errors and aborted bodies inside the request's error path. */
export async function receive(source: AsyncIterable<Buffer>, dest: string, limit: number) {
  const file = await open(dest, "wx");
  let size = 0;
  try {
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > limit) throw new Error("too large");
        yield chunk;
      }
    }, file.createWriteStream());
    return size;
  } catch (error) {
    await file.close();
    await rm(dest, { force: true });
    throw error;
  }
}
