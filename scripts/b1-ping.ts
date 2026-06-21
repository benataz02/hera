import { ServiceLayerClient } from "../apps/agent/src/service-layer-client.ts";

const sl = new ServiceLayerClient({
  baseUrl: process.env.B1_BASE_URL!,
  companyDb: process.env.B1_COMPANY_DB!,
  user: process.env.B1_USER!,
  pass: process.env.B1_PASS!,
  insecureTls: process.env.B1_INSECURE_TLS === "true",
});

const t0 = Date.now();
const r = await sl.getBusinessPartner("__ping_nonexistent__");
console.log(`B1 fresh login + GET ok in ${Date.now() - t0}ms (result: ${r})`);
process.exit(0);
