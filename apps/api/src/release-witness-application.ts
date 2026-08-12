import type {
  CleanupEvidencePort,
  CleanupObservationSeedPort,
  RenderCleanupObservationPort,
} from "./release-witness-domain.js";

export class ObserveRunnerCleanup {
  constructor(
    private readonly seeds: CleanupObservationSeedPort,
    private readonly render: RenderCleanupObservationPort,
    private readonly evidence: CleanupEvidencePort,
  ) {}

  async execute(jobId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(jobId))
      throw Object.assign(new Error("release_witness_job_identity_invalid"), {
        statusCode: 400,
      });
    const seed = await this.seeds.load(jobId);
    if (seed.jobId !== jobId)
      throw new Error("release_witness_seed_identity_mismatch");
    const evidence = await this.render.observe(seed);
    await this.evidence.persist(jobId, evidence);
  }
}
