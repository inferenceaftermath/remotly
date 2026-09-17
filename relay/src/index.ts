// Worker entry: one relay per isolate so the senders keep their cached upstream credentials between requests.
// Real fetch, real clock; everything testable lives in relay.ts / upstream.ts.
import { createRelay } from './relay.ts';

const relay = createRelay();

export default {
  fetch(request, env): Promise<Response> {
    return relay.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
