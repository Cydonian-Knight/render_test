const express = require('express');
const path = require('path');
const { getGeoInfo } = require('./services/geo');

const app = express();
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

/*
|--------------------------------------------------------------------------
| CPU — process.cpuUsage() en lugar de si.currentLoad()
| En contenedor, systeminformation lee /proc del HOST, no del contenedor.
| process.cpuUsage() mide el uso real de este proceso Node.
|--------------------------------------------------------------------------
*/
let lastCpuUsage = process.cpuUsage();
let cpuPercent = 0;

/*
|--------------------------------------------------------------------------
| EVENT LOOP LAG — crítico para detectar bloqueos
| Si el lag supera ~50ms de forma constante, el servidor está saturado.
|--------------------------------------------------------------------------
*/
let eventLoopLag = 0;

/*
|--------------------------------------------------------------------------
| TRAFFIC TRACKER
|--------------------------------------------------------------------------
*/
let totalInBytes = 0;
let totalOutBytes = 0;
let lastInBytes = 0;
let lastOutBytes = 0;
let currentInMBs = 0;
let currentOutMBs = 0;

app.use((req, res, next) => {
    // Contamos bytes del body del request via chunks (más preciso que content-length)
    let inBytes = 0;
    req.on('data', (chunk) => {
        inBytes += chunk.length;
    });
    req.on('end', () => {
        totalInBytes += inBytes;
    });

    // Contamos bytes de la respuesta
    let outgoing = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, ...args) {
        if (chunk) outgoing += Buffer.byteLength(chunk);
        return originalWrite.apply(this, [chunk, ...args]);
    };

    res.end = function (chunk, ...args) {
        if (chunk) outgoing += Buffer.byteLength(chunk);
        totalOutBytes += outgoing;
        return originalEnd.apply(this, [chunk, ...args]);
    };

    next();
});

/*
|--------------------------------------------------------------------------
| CALCULATE STATS EACH 5s
|--------------------------------------------------------------------------
*/
setInterval(() => {
    // CPU — diff desde el último intervalo
    const currentCpu = process.cpuUsage(lastCpuUsage);
    const elapsedUs = 5000 * 1000; // 5s en microsegundos
    cpuPercent = ((currentCpu.user + currentCpu.system) / elapsedUs * 100).toFixed(2);
    lastCpuUsage = process.cpuUsage();

    // Red MB/s
    const inDiff = totalInBytes - lastInBytes;
    const outDiff = totalOutBytes - lastOutBytes;
    currentInMBs = inDiff / 1024 / 1024 / 5;
    currentOutMBs = outDiff / 1024 / 1024 / 5;
    lastInBytes = totalInBytes;
    lastOutBytes = totalOutBytes;
}, 5000);

// Event loop lag — se mide cada segundo con hrtime para mayor precisión
setInterval(() => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
        const lag = Number(process.hrtime.bigint() - start) / 1e6; // ms
        eventLoopLag = lag.toFixed(2);
    });
}, 1000);

/*
|--------------------------------------------------------------------------
| DISK — si.fsSize() es inestable en contenedor, usamos df como fallback
|--------------------------------------------------------------------------
*/
async function getDiskUsage() {
    try {
        const { execFile } = require('child_process');
        return await new Promise((resolve) => {
            execFile('df', ['-k', '/'], { timeout: 3000 }, (err, stdout) => {
                if (err) return resolve('0');
                const lines = stdout.trim().split('\n');
                const parts = lines[1]?.split(/\s+/);
                if (!parts || parts.length < 5) return resolve('0');
                const use = parseFloat(parts[4]); // viene como "42%"
                resolve(isNaN(use) ? '0' : use.toFixed(2));
            });
        });
    } catch {
        return '0';
    }
}

/*
|--------------------------------------------------------------------------
| METRICS
|--------------------------------------------------------------------------
*/
app.get('/api/metrics', async (req, res) => {
    try {
        const nodeMem = process.memoryUsage();

        const ip =
            req.headers['x-forwarded-for'] ||
            req.socket.remoteAddress;

        const [geo, disk] = await Promise.all([
            getGeoInfo(ip),
            getDiskUsage(),
        ]);

        res.json({
            cpu: cpuPercent,
            ram: {
                rss:       (nodeMem.rss       / 1024 / 1024).toFixed(2),
                heapUsed:  (nodeMem.heapUsed  / 1024 / 1024).toFixed(2),
                heapTotal: (nodeMem.heapTotal / 1024 / 1024).toFixed(2),
                external:  (nodeMem.external  / 1024 / 1024).toFixed(2),
            },
            disk,
            network: {
                in:  currentInMBs.toFixed(4),
                out: currentOutMBs.toFixed(4),
            },
            eventLoopLag,
            geo,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Running on ${PORT}`);
});
