export async function syncPrivateArtifacts({ envConfig, logger }) {
  if (!envConfig.privateDataRepoPat || !envConfig.privateDataRepo) {
    logger.info("private data sync skipped");
    return { synced: false, reason: "missing private repo settings" };
  }

  logger.info("private data sync configured but left as API extension point", {
    repo: envConfig.privateDataRepo
  });
  return { synced: false, reason: "not_implemented" };
}
