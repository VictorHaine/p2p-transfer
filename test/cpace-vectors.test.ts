import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ristretto255 } from "@cipherman/pake-js/cpace";

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replace(/\s+/g, ""), "hex"));
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function leScalar(value: string): bigint {
  const bytes = hexBytes(value);
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    result = (result << 8n) | BigInt(bytes[index] as number);
  }
  return result;
}

test("CPace Ristretto255 matches draft-20 Appendix B.3 vector bytes", () => {
  const prs = hexBytes("50617373776f7264");
  const ci = hexBytes("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = hexBytes("7e4b4791d6a8ef019b936c79fb7f2c57");
  const ada = hexBytes("414461");
  const adb = hexBytes("414462");
  const ya = leScalar("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08");
  const yb = leScalar("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d");

  const generatorString = ristretto255.__generatorString(prs, ci, sid);
  assert.equal(generatorString.byteLength, 170);
  assert.equal(
    toHex(createHash("sha512").update(generatorString).digest()),
    "da6d3ddc8802fca9058755ffd3ebde08a9c2c74945901a258482a288b6663af06bf645c93cd1c51512307199c80e84908916d983b34af77205f90851a657ee27"
  );
  assert.equal(
    toHex(ristretto255.__calculateGeneratorEncoded(prs, ci, sid)),
    "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56"
  );

  const alice = ristretto255.__initWithScalar({ PRS: prs, sid, CI: ci }, ya);
  const bob = ristretto255.__initWithScalar({ PRS: prs, sid, CI: ci }, yb);
  assert.equal(toHex(alice.share), "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157");
  assert.equal(toHex(bob.share), "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258");
  assert.equal(toHex(ristretto255.__scalarMultVfy(alice.ephemeralSecret, bob.share)), "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f");
  assert.equal(toHex(ristretto255.__scalarMultVfy(bob.ephemeralSecret, alice.share)), "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f");

  const aliceIsk = ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: alice.ephemeralSecret,
    ownShare: alice.share,
    peerShare: bob.share,
    ownAD: ada,
    peerAD: adb,
    sid,
    role: "initiator"
  });
  const bobIsk = ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: bob.ephemeralSecret,
    ownShare: bob.share,
    peerShare: alice.share,
    ownAD: adb,
    peerAD: ada,
    sid,
    role: "responder"
  });
  const expectedIsk = "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447";
  assert.equal(toHex(aliceIsk), expectedIsk);
  assert.equal(toHex(bobIsk), expectedIsk);
});
