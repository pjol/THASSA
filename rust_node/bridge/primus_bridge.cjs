#!/usr/bin/env node

function loadPrimusZk() {
  const candidates = [
    '@primuslabs/zktls-core-sdk/dist/primus_zk.js',
    '@primuslabs/zktls-core-sdk/dist/primus_zk',
  ];

  let lastError;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('could not resolve @primuslabs/zktls-core-sdk/dist/primus_zk');
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('missing bridge invocation JSON on stdin');
  }

  const invocation = JSON.parse(raw);
  const { init, getAttestation, getAttestationResult } = loadPrimusZk();
  const writeStderr = (method, args) => {
    const line = args
      .map((arg) => {
        if (typeof arg === 'string') {
          return arg;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    process.stderr.write(`[primus-bridge:${method}] ${line}\n`);
  };

  console.log = (...args) => writeStderr('log', args);
  console.warn = (...args) => writeStderr('warn', args);
  console.error = (...args) => writeStderr('error', args);

  let result;
  switch (invocation.method) {
    case 'attest': {
      await init(invocation.params?.mode || 'auto');
      const attestation = await getAttestation(invocation.params?.attestationParams || {});
      if (attestation?.retcode !== '0') {
        result = attestation;
        break;
      }
      result = await getAttestationResult(invocation.params?.timeoutMs || 120000);
      break;
    }
    case 'init':
      result = await init(invocation.params?.mode || 'auto');
      break;
    case 'getAttestation':
      result = await getAttestation(invocation.params || {});
      break;
    case 'getAttestationResult':
      result = await getAttestationResult(invocation.params?.timeoutMs || 120000);
      break;
    default:
      throw new Error(`unsupported bridge method: ${invocation.method}`);
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  const errorString =
    error && error.message
      ? String(error.message)
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
  const payload = {
    error: errorString,
    details: error && typeof error === 'object' ? error : undefined,
    stack: error && error.stack ? String(error.stack) : undefined,
  };
  process.stderr.write(`${payload.error}\n`);
  process.stdout.write(JSON.stringify(payload));
  process.exit(1);
});
