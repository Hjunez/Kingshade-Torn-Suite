import { KINGSHADE_PROJECTS } from '../repository/registry.js';
import { WorkerAgentService } from './agent-tools.js';
import { WriteApprovalStore } from './approval.js';
import { runWorkerDoctor, type WorkerDoctorReport } from './doctor.js';
import { WorkerPolicyRegistry } from './policy.js';

export interface ConfiguredWorkerServiceOptions {
  repositoryRoot: string;
  expectedGitHubRepository: string;
  workspaceBaseDir?: string;
}

export interface ConfiguredWorkerService {
  service: WorkerAgentService;
  doctor: WorkerDoctorReport;
}

export async function createConfiguredWorkerService(
  options: ConfiguredWorkerServiceOptions,
): Promise<ConfiguredWorkerService> {
  const doctor = await runWorkerDoctor({
    repositoryRoot: options.repositoryRoot,
    trustedExpectedRepository: options.expectedGitHubRepository,
  });
  if (!doctor.readyForLocalWorker) {
    const failures = doctor.checks
      .filter((check) => check.required && check.status !== 'pass')
      .map((check) => `${check.name}: ${check.detail}`);
    throw new Error('Local Worker Doctor failed: ' + failures.join('; '));
  }

  const policies = new WorkerPolicyRegistry(
    KINGSHADE_PROJECTS.map((project) => ({
      projectId: project.id,
      repositoryRoot: doctor.repositoryRoot,
      readablePaths: project.primaryFiles,
      writablePaths: project.primaryFiles,
      allowedTestProfileIds: project.testProfiles,
      requiredWriteTestProfileIds: project.testProfiles,
      branchPrefix: `ks-leslie/${project.id}/`,
    })),
  );
  return {
    doctor,
    service: new WorkerAgentService({
      policies,
      approvals: new WriteApprovalStore(),
      ...(options.workspaceBaseDir === undefined
        ? {}
        : { workspaceBaseDir: options.workspaceBaseDir }),
    }),
  };
}
