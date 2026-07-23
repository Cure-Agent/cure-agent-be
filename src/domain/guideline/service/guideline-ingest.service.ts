import { Injectable } from '@nestjs/common';
import { GuidelineIngestInput, GuidelineIngestResult } from './guideline-ingest.input';

@Injectable()
export class GuidelineIngestService {
  ingest(_input: GuidelineIngestInput): Promise<GuidelineIngestResult> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }
}
