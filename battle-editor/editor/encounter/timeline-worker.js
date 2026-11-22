import { runTimelineSimulation } from './timeline.js';

self.onmessage = async ({ data: { doc, options } }) => {
  self.postMessage(await runTimelineSimulation(doc, options));
};
