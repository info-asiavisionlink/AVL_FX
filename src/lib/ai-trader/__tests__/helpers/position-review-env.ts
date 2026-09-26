// position-review-runtime reads the gateway URL at module load; set it first.
// Always overwrite: a developer shell / --env-file may carry the Production
// Gateway URL and secret, which a test must never use.
process.env.MT5_GATEWAY_URL = "http://gateway.stage5.test";
process.env.MT5_GATEWAY_SECRET = "stage5-gateway-secret";
process.env.CONSOLE_URL = "http://console.stage5.test";
