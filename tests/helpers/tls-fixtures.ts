import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ThrowawayTlsMaterial = {
  dir: string;
  caPem: string;
  serverCertPem: string;
  serverKeyPem: string;
  clientCertPem: string;
  clientKeyPem: string;
};

async function runOpenSsl(args: string[], cwd: string): Promise<void> {
  await execFileAsync("openssl", args, { cwd });
}

/**
 * Generates a throwaway private CA, server cert (SAN IP:127.0.0.1) and client
 * cert for worker integration tests. Never committed.
 */
export async function createThrowawayTlsMaterial(): Promise<ThrowawayTlsMaterial> {
  const dir = await mkdtemp(join(tmpdir(), "gramscope-worker-tls-"));
  const extFile = join(dir, "server.ext");
  await writeFile(
    extFile,
    "subjectAltName=IP:127.0.0.1\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );

  await runOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-subj",
      "/CN=GramScope Test CA",
    ],
    dir,
  );

  await runOpenSsl(
    [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-sha256",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=gramscope-worker-test",
    ],
    dir,
  );

  await runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-out",
      "server.crt",
      "-extfile",
      "server.ext",
    ],
    dir,
  );

  await runOpenSsl(
    [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-sha256",
      "-nodes",
      "-keyout",
      "client.key",
      "-out",
      "client.csr",
      "-subj",
      "/CN=gramscope-vercel-test",
    ],
    dir,
  );

  await runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      "client.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-out",
      "client.crt",
    ],
    dir,
  );

  const [caPem, serverCertPem, serverKeyPem, clientCertPem, clientKeyPem] =
    await Promise.all([
      readFile(join(dir, "ca.crt"), "utf8"),
      readFile(join(dir, "server.crt"), "utf8"),
      readFile(join(dir, "server.key"), "utf8"),
      readFile(join(dir, "client.crt"), "utf8"),
      readFile(join(dir, "client.key"), "utf8"),
    ]);

  return {
    dir,
    caPem,
    serverCertPem,
    serverKeyPem,
    clientCertPem,
    clientKeyPem,
  };
}

export async function removeThrowawayTlsMaterial(
  material: ThrowawayTlsMaterial,
): Promise<void> {
  await rm(material.dir, { recursive: true, force: true });
}
