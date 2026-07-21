import { EventEmitter } from 'events';
import type { GenerationProgressEvent } from '../generators/checkpoint';

class GenerationProgressBus extends EventEmitter {
  emitProgress(event: GenerationProgressEvent): void {
    this.emit('generation:progress', event);
  }
}

export const generationProgressBus = new GenerationProgressBus();
