import { db } from "./config/firebase-config.js";
import { buildTrial } from "./utils/trial.js";

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply");
const resetExisting = args.has("--reset-existing");

const hasValidTrial = (trial) => {
  if (!trial?.startDate || !trial?.endDate) return false;
  const startDate = new Date(trial.startDate);
  const endDate = new Date(trial.endDate);
  return !Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime());
};

const run = async () => {
  const snapshot = await db
    .collection("users")
    .where("subscription.plan", "==", "free")
    .get();

  const now = new Date();
  const trial = buildTrial(now);
  const candidates = [];
  let skippedForRole = 0;
  let skippedExistingTrial = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};

    if ((data.role || "user") !== "user") {
      skippedForRole += 1;
      return;
    }

    if (!resetExisting && hasValidTrial(data.trial)) {
      skippedExistingTrial += 1;
      return;
    }

    candidates.push({
      id: doc.id,
      email: data.email || "",
      currentTrial: data.trial || null,
    });
  });

  console.log(`[trial-backfill] Free user records found: ${snapshot.size}`);
  console.log(`[trial-backfill] Candidate users: ${candidates.length}`);
  console.log(`[trial-backfill] Skipped non-user roles: ${skippedForRole}`);
  console.log(`[trial-backfill] Skipped users with existing valid trial: ${skippedExistingTrial}`);
  console.log(
    `[trial-backfill] Mode: ${shouldApply ? "APPLY" : "DRY RUN"}${resetExisting ? " + RESET EXISTING" : ""}`
  );

  if (candidates.length > 0) {
    console.log("[trial-backfill] Sample candidates:");
    candidates.slice(0, 20).forEach((candidate) => {
      console.log(` - ${candidate.id} ${candidate.email}`.trim());
    });
  }

  if (!shouldApply) {
    console.log("[trial-backfill] No changes written. Re-run with --apply to persist updates.");
    return;
  }

  const batchSize = 400;
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = db.batch();
    const chunk = candidates.slice(index, index + batchSize);

    chunk.forEach((candidate) => {
      const userRef = db.collection("users").doc(candidate.id);
      batch.update(userRef, { trial });
    });

    await batch.commit();
    console.log(
      `[trial-backfill] Updated ${Math.min(index + batchSize, candidates.length)} of ${candidates.length}`
    );
  }

  console.log(
    `[trial-backfill] Done. Activated ${trial.endDate} expiry for ${candidates.length} free user(s).`
  );
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[trial-backfill] Failed:", error);
    process.exit(1);
  });
