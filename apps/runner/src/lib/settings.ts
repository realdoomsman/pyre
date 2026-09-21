import { prisma } from "@pyre/db";

/** `PlatformSetting.pause_builds === true` halts new build scheduling and defers queued builds. */
export const buildsPaused = async (): Promise<boolean> => {
  const row = await prisma.platformSetting.findUnique({ where: { key: "pause_builds" } });
  return row?.value === true;
};
