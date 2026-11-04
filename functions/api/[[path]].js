// Cloudflare Pages Function entrypoint - v2.1.0 Real-time MIS integration
import worker from "../../src/index.js";

export async function onRequest(context) {
    return worker.fetch(context.request, context.env, context);
}

