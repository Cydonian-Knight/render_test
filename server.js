
const express = require('express');
const path = require('path');
const si = require('systeminformation');

const { getGeoInfo } = require('./services/geo');

const app = express();

app.set('trust proxy', true);

app.use(express.static(
    path.join(__dirname, 'public')
));

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

    const incoming =
        Number(req.headers['content-length']) || 0;

    totalInBytes += incoming;

    let outgoing = 0;

    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, ...args) {

        if (chunk) {
            outgoing += Buffer.byteLength(chunk);
        }

        return originalWrite.apply(this, [chunk, ...args]);
    };

    res.end = function (chunk, ...args) {

        if (chunk) {
            outgoing += Buffer.byteLength(chunk);
        }

        totalOutBytes += outgoing;

        return originalEnd.apply(this, [chunk, ...args]);
    };

    next();
});

/*
|--------------------------------------------------------------------------
| CALCULATE MB/S
|--------------------------------------------------------------------------
*/

setInterval(() => {

    const inDiff =
        totalInBytes - lastInBytes;

    const outDiff =
        totalOutBytes - lastOutBytes;

    currentInMBs =
        inDiff / 1024 / 1024 / 5;

    currentOutMBs =
        outDiff / 1024 / 1024 / 5;

    lastInBytes = totalInBytes;
    lastOutBytes = totalOutBytes;

}, 5000);

/*
|--------------------------------------------------------------------------
| METRICS
|--------------------------------------------------------------------------
*/

app.get('/api/metrics', async (req, res) => {

    try {

        const cpu =
            await si.currentLoad();

        const disks =
            await si.fsSize();

        const nodeMem =
            process.memoryUsage();

        const ip =
            req.headers['x-forwarded-for'] ||
            req.socket.remoteAddress;

        const geo =
            await getGeoInfo(ip);

        res.json({

            cpu:
                cpu.currentLoad.toFixed(2),

            ram: {

                rss:
                    (
                        nodeMem.rss /
                        1024 /
                        1024
                    ).toFixed(2),

                heapUsed:
                    (
                        nodeMem.heapUsed /
                        1024 /
                        1024
                    ).toFixed(2),

                heapTotal:
                    (
                        nodeMem.heapTotal /
                        1024 /
                        1024
                    ).toFixed(2)
            },

            disk:
                disks[0]?.use?.toFixed(2) || '0',

            network: {

                in:
                    currentInMBs.toFixed(4),

                out:
                    currentOutMBs.toFixed(4)
            },

            geo
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });
    }
});

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Running on ${PORT}`);
});
