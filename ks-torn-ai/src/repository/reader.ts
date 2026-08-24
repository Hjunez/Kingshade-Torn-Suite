import type { GitCommitObservation } from './evidence-adapters.js';
import type {
  GitHubCompareObservation,
  GitHubFileObservation,
} from './github-reader.js';

export interface RepositoryReader {
  readFile(path: string, ref: string): Promise<GitHubFileObservation>;
  listCommits(options: {
    ref: string;
    path?: string;
    limit?: number;
  }): Promise<readonly GitCommitObservation[]>;
  compareRefs(baseRef: string, headRef: string): Promise<GitHubCompareObservation>;
}
