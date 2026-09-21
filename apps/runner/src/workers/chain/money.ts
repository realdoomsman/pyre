import { prisma } from "@pyre/db";

/** PlatformSetting `<key>` === true pauses the corresponding worker. */
export async function isPaused(key: "pauseFeeSweep" | "pauseBuyback"): Promise<boolean> {
  const setting = await prisma.platformSetting.findUnique({ where: { key } });
  return setting?.value === true;
}
