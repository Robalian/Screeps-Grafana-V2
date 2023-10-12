// eslint-disable-next-line import/no-unresolved
import cron from 'node-cron';
// eslint-disable-next-line import/no-unresolved
import graphite from 'graphite';
import { createLogger, format, transports } from 'winston';
// eslint-disable-next-line import/no-unresolved
import 'winston-daily-rotate-file';
import fs from 'fs';
import * as dotenv from 'dotenv';
// eslint-disable-next-line import/no-unresolved
import express from 'express';
import ApiFunc from './apiFunctions.js';

const app = express();
const port = 10004;

const users = JSON.parse(fs.readFileSync('users.json'));
dotenv.config();

const pushTransport = new transports.DailyRotateFile({
  filename: 'logs/push-%DATE%.log',
  auditFile: 'logs/push-audit.json',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});
const cronTransport = new transports.DailyRotateFile({
  filename: 'logs/cron-%DATE%.log',
  auditFile: 'logs/cron-audit.json',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});

const client = graphite.createClient('plaintext://carbon-relay-ng:2003/');
const { combine, timestamp, prettyPrint } = format;
const logger = createLogger({
  format: combine(
    timestamp(),
    prettyPrint(),
  ),
  transports: [pushTransport],
});

const cronLogger = createLogger({
  format: combine(
    timestamp(),
    prettyPrint(),
  ),
  transports: [cronTransport],
});

class ManageStats {
  statsUsername;
  user;
  shardIndex;
  perTickStatsInfo;

  constructor(user) {
    this.user = user;
    this.statsUsername = (user.prefix ? `${user.prefix}.` : '') + user.username;
    this.shardIndex = 0;
    this.perTickStatsInfo = {};
    for (let shard of user.shards) {
      this.perTickStatsInfo[shard] = {
        prevLastTick: undefined,
        prevLastTickTime: undefined,
        lastTick: undefined,
        lastTickTime: undefined
      }
    }
  }

  async handleUser() {
    this.message = '----------------------------------------------------------------\r\n';

    const { user } = this;
    
    const shard = user.shards[this.shardIndex];
    this.shardIndex = (this.shardIndex + 1) % user.shards.length;

    await this.getLoginInfo();
    const stats = user.segment === undefined
      ? await ApiFunc.getMemory(user, shard)
      : await ApiFunc.getSegmentMemory(user, shard);
    
    const processedStats = this.processStats(shard, stats);

    for (let statsEntry of processedStats) {
      const reportStatsResult = await ManageStats.reportStats(statsEntry.data, statsEntry.timestamp);
      if (!reportStatsResult) {
        console.log(`Error while pushing stats. timestamp = ${statsEntry.timestamp}`);
      }
      else {
        this.message += `Pushed ${user.type} stats from shard ${shard} to graphite. timestamp = ${statsEntry.timestamp}\r\n`;
      }
    }

    if (processedStats.length > 0) {
      logger.info(this.message);
      console.log(this.message);
    }
    else {
      this.message += 'Pushed no stats to graphite';
      logger.info(this.message);
      console.log(this.message);
    }
  }

  async getLoginInfo() {
    const { user } = this;
    if (user.type === 'private') {
      user.token = await ApiFunc.getPrivateServerToken(user);
    }
    return user.token;
  }

  processStats(shard, stats) {
    if (Object.keys(stats).length === 0)
      return [];

    const { user } = this;
    if (user.petTickData) {
      const perTickStatsInfo = this.perTickStatsInfo[shard];
      perTickStatsInfo.prevLastTick = perTickStatsInfo.lastTick;
      perTickStatsInfo.prevLastTickTime = perTickStatsInfo.lastTickTime;
      perTickStatsInfo.lastTick = Object.keys(stats).map(key => parseInt(key.replace('"', ''))).reduce((a, b) => a > b ? a : b)
      perTickStatsInfo.lastTickTime = Date.now();

      const tickDiff = perTickStatsInfo.lastTick - perTickStatsInfo.prevLastTick;
      const tickTimeDiff = perTickStatsInfo.lastTickTime - perTickStatsInfo.prevLastTickTime;
      const perTickTimeDiff = tickTimeDiff / tickDiff;

      if (!perTickStatsInfo.prevLastTick || !perTickStatsInfo.lastTick)
        return [];

      let result = [];
      for (let i = 0; i < tickDiff; ++i) {
        const tick = perTickStatsInfo.prevLastTick + i;
        const time = Math.ceil(perTickStatsInfo.prevLastTickTime + i * perTickTimeDiff);
        const tickStats = stats[tick];
        if (tickStats) {
          result.push({
            timestamp: time,
            data: {
              [this.statsUsername]: {
                [shard]: tickStats
              }
            }
          });
        }
      }
      return result;
    }
    else {
      return [{
        timestamp: Date.now(),
        data: {
          [this.statsUsername]: {
            [shard]: stats
          }
        }
      }];
    }
  }

  static async reportStats(stats, timestamp) {
    return new Promise((resolve) => {
      client.write(
        {
          [`${process.env.PREFIX ? `${process.env.PREFIX}.` : ''}screeps`]: stats
        },
        timestamp,
        (err) => {
          if (err) {
            console.log(err);
            logger.error(err);
            resolve(false);
          }
          else {
            resolve(true);
          }
        }
      );
    });
  }
}

for (let user of users) {
  const userStatsGetter = new ManageStats(user);
  cron.schedule('*/10 * * * * *', async () => {
    const message = `Cron event hit: ${new Date()}`;
    console.log(`\r\n${message}`);
    cronLogger.info(message);
    userStatsGetter.handleUser();
  });
}