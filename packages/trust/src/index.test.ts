import { describe, expect, it } from "vitest";
import { derivePeerIdFromCertificatePem, evaluateTrust } from "./index.js";

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDXDCCAkSgAwIBAgIUVrQi6yqdjtSa0Mz2oM5onOk4njswDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQQUNMIERldiBMb2NhbCBDQTAeFw0yNjAzMTAwMDEzNTVa
Fw0yODA2MTIwMDEzNTVaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAIkX0cJlzGS9gpcwaD6flHbeMboapP+8u2Yj
Xyrrpck05c4Bl/SECJ3jqEyDyU28zJfZ+FurIdCFhV2yvB8LLyAIXC0BAbEg1n7u
gCVDCbTao46ZfgBFqy9vjAK2e4s7gbszk83apAhcw1jrfS2OgQcBm35tCzXZ9gXc
mYWbGKF6OztMJLUB9Snv+vlMufOPu/GgOB7vHQDEFC5S0Wum+RxtIV52QNIezBG2
hNZnaKtEjQJJzjMo78LjOrvno9xYD8pfpeivZHu0GEnBtRTQlP1qQxH09QPCGQta
sLtnZDzsByLe4gTHp9LVvMCqcU2QXbfi49O30ESUPNNmKbaemB8CAwEAAaOBnjCB
mzAsBgNVHREEJTAjgglsb2NhbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEw
CQYDVR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYD
VR0OBBYEFFeOMnxR1DjHuC+j+deaKlJdgWIkMB8GA1UdIwQYMBaAFDEqRW+p2leT
dL6FZosLoqalVQ3lMA0GCSqGSIb3DQEBCwUAA4IBAQCnN+ER1/lNAidMc7bY/SeL
aLTDCRblNDJkDo9tMZr+FnLLA8bc6YyJZjcbZq7JcOJaLdnT3fopqLbwMw23gw/P
bWNETVX2FNk57YnHk2Jxt2OMU1DsYDsFTPEkNWLwFe4WYmKmWAZ/aJnGDb0qHTBo
t48UVil8waDvd0oiSb3KYZfnYdkZx1fvpdSljcw/r9l8WL1koPd/O5jfnY/OLXkv
ZLyXj7fJL1YoklOzNWhxWTgiNkz7U/3zPMOHY+4IRJVWx8dvl6PQrXPzwyhNGWa7
8heDR2kQeYlGyXa2xybIhwtbS4Sfk44hn4n1Sip/mMbBvCrm9r13GmVIpBMc+Du4
-----END CERTIFICATE-----`;

describe("trust", () => {
  it("derives a stable peer id from a certificate", () => {
    expect(derivePeerIdFromCertificatePem(TEST_CERT_PEM)).toBe("peer_spki_sha256_xmy5oj6b7tciyinwlyz2yw6wikts4m2xwbdespnguashmrb5g57a");
  });

  it("evaluates mismatched pins", () => {
    const result = evaluateTrust(
      {
        agentId: "acme.reviewer.agent",
        endpoint: { transport: "wss", url: "wss://example.test/agents/acme.reviewer.agent", priority: 0 },
        pinnedPeerId: "peer_spki_sha256_expected"
      },
      "peer_spki_sha256_observed"
    );
    expect(result.status).toBe("mismatch");
  });
});
