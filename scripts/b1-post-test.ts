import { ServiceLayerClient } from "../apps/agent/src/service-layer-client.ts";

const sl = new ServiceLayerClient({
  baseUrl: process.env.B1_BASE_URL!,
  companyDb: process.env.B1_COMPANY_DB!,
  user: process.env.B1_USER!,
  pass: process.env.B1_PASS!,
  insecureTls: process.env.B1_INSECURE_TLS === "true",
  timeoutMs: 90_000, // generous so we measure, not abort
});

const code = "ZHERA" + Date.now().toString().slice(-8);
const tLogin = Date.now();
await sl.getBusinessPartner("__warm_login__"); // forces login first
console.log(`login+get: ${Date.now() - tLogin}ms`);

const tPost = Date.now();
await sl.createBusinessPartner({ CardCode: code, CardName: "Hera POST timing" });
console.log(`POST ${code}: ${Date.now() - tPost}ms`);
process.exit(0);
