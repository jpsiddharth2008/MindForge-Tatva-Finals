// GET /api/health: the state of each component, never any credential, address or error text.
// Each check resolves to 'ok' or 'not_configured'; throwing or timing out means 'down'.

const { rpc, TIMEOUT_MS } = require('./chain');

/** Checks for the Polygon node and the deployed contract, from RPC_URL and CONTRACT_ADDRESS. */
function chainChecks(env = process.env, fetchFn = fetch) {
    return {
        polygon_rpc: async () => {
            if (!env.RPC_URL) return 'not_configured';
            await rpc(env.RPC_URL, 'eth_blockNumber', [], fetchFn);
            return 'ok';
        },
        contract: async () => {
            if (!env.CONTRACT_ADDRESS || !env.RPC_URL) return 'not_configured';
            const code = await rpc(env.RPC_URL, 'eth_getCode', [env.CONTRACT_ADDRESS, 'latest'], fetchFn);
            if (code === '0x') throw new Error('no bytecode at address');
            return 'ok';
        },
    };
}

async function runChecks(checks, timeoutMs = TIMEOUT_MS + 500) {
    const components = {};
    await Promise.all(Object.entries(checks).map(async ([name, check]) => {
        try {
            const state = await Promise.race([
                check(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
            ]);
            components[name] = state === 'not_configured' ? 'not_configured' : 'ok';
        } catch {
            components[name] = 'down';     // the reason stays out of the response on purpose
        }
    }));
    return components;
}

function healthHandler(checks, { timeoutMs } = {}) {
    return async (req, res) => {
        const components = await runChecks(checks, timeoutMs);
        const down = Object.values(components).includes('down');
        res.status(down ? 503 : 200).json({ status: down ? 'degraded' : 'ok', uptimeSeconds: Math.round(process.uptime()), components });
    };
}

module.exports = { healthHandler, runChecks, chainChecks };
