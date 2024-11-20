import {
  finishEvent,
  getPublicKey,
  nip19,
  relayInit,
  validateEvent,
  verifySignature,
  type Event,
  type Filter,
  type Relay,
} from "nostr-tools";
import "websocket-polyfill";

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";

import * as Sentry from "@sentry/node";
import axios from "axios";
import * as chrono from "chrono-node";
import {
  addDays,
  format,
  fromUnixTime,
  getHours,
  getUnixTime,
  parse,
  subDays,
  subMonths,
  subSeconds,
  subWeeks,
} from "date-fns";
import FormData from "form-data";
import { Redis } from "ioredis";
import { MeiliSearch } from "meilisearch";
import * as cron from "node-cron";
import * as emoji from "node-emoji";
import StaticMaps from "staticmaps";

import * as CONST from "@/lib/const.js";
import * as ENVIRONMENT from "@/lib/environment.js";

/**
 * 現在のUnixtimeを返す
 * @returns {number} 現在のUnixtime
 */
const currUnixtime = (): number => getUnixTime(new Date());

const START_TIME = currUnixtime();

const redis =
  ENVIRONMENT.REDIS_URL.length !== 0 ? new Redis(ENVIRONMENT.REDIS_URL) : null;

if (ENVIRONMENT.SENTRY_URL.length !== 0) {
  Sentry.init({
    dsn: ENVIRONMENT.SENTRY_URL,
    tracesSampleRate: 1.0,
  });
}

/**
 * テキスト投稿イベント(リプライ)を組み立てる
 * @param {string} content 投稿内容
 * @param {Event} targetEvent リプライ対象のイベント
 * @returns {Event}
 */
const composeReplyPost = (content: string, targetEvent: Event): Event => {
  const tags = [];
  const eTags = targetEvent.tags.filter((x) => x[0] === "e");
  if (targetEvent.kind === 42) {
    for (const tag of eTags) tags.push(tag);
  } else if (eTags.length > 0) {
    tags.push(
      eTags.findLast(([, , , marker]) => marker === "root") ?? eTags[0],
    );
  }
  tags.push(["e", targetEvent.id], ["p", targetEvent.pubkey]);
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const created_at: number =
    targetEvent !== null ? targetEvent.created_at + 1 : currUnixtime() + 1;
  const ev = {
    kind: targetEvent.kind,
    content,
    tags,
    created_at,
  };

  // イベントID(ハッシュ値)計算・署名
  return finishEvent(ev, ENVIRONMENT.BOT_PRIVATE_KEY_HEX);
};

/**
 * テキスト投稿イベントを組み立てる
 * @param {string} content
 * @param {Event} originalEvent オリジナルイベント
 * @returns {Event}
 */
const composePost = (
  content: string,
  originalEvent: Event | null = null,
): Event => {
  const kind = originalEvent != null ? originalEvent.kind : 1;
  const tags = [];
  if (originalEvent != null && originalEvent.kind === 42) {
    tags.push(["e", originalEvent.id]);
    for (const tag of originalEvent.tags.filter((x: any[]) => x[0] === "e"))
      tags.push(tag);
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const created_at: number =
    originalEvent != null ? originalEvent.created_at + 1 : currUnixtime() + 1;
  const ev = {
    kind,
    content,
    tags,
    created_at,
  };

  // イベントID(ハッシュ値)計算・署名
  return finishEvent(ev, ENVIRONMENT.BOT_PRIVATE_KEY_HEX);
};

/**
 * リアクションイベントを組み立てる
 * @param {string} emoji リアクションで使う絵文字
 * @param {Event} targetEvent リアクション対象のイベント
 * @returns {Event}
 */
const composeReaction = (emoji: string, targetEvent: Event): Event => {
  const ev = {
    kind: 7,
    content: emoji,
    tags: [
      ["e", targetEvent.id],
      ["p", targetEvent.pubkey],
    ],
    created_at: currUnixtime() + 1,
  };

  // イベントID(ハッシュ値)計算・署名
  return finishEvent(ev, ENVIRONMENT.BOT_PRIVATE_KEY_HEX);
};

/**
 * リレーにイベントを送信
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<void>}
 */
const publishToRelay = async (relay: Relay, ev: Event): Promise<void> => {
  await relay
    .publish(ev)
    .then(() => {
      console.log("大根");
    })
    .catch((e: any) => {
      console.log(`人参: ${e}`);
    });
};

/**
 * strfryへコマンド実行する
 * @param {Filter} filter クエリフィルター
 * @returns {Promise<string[]>}
 */
const strfryScan = async (filter: Filter): Promise<string[]> => {
  const execParams = ["scan", JSON.stringify(filter)];

  const execOpts: childProcess.CommonSpawnOptions = {
    stdio: ["ignore", "pipe", "ignore"],
  };

  const strfryProcess = childProcess.spawn(
    ENVIRONMENT.STRFRY_EXEC_PATH,
    execParams,
    execOpts,
  );
  const rl = readline.createInterface({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    input: strfryProcess.stdout!,
    crlfDelay: Infinity,
  });

  const output = [];
  for await (const line of rl) {
    output.push(line);
  }

  return output;
};

/**
 * strfryからクエリしたイベントをカウントさせる
 * @param {Filter} filter クエリフィルター
 * @returns {number}
 */
const strfryCount = (filter: Filter): number => {
  const execParams = ["scan", JSON.stringify(filter), "--count"];

  return Number(
    childProcess.execFileSync(ENVIRONMENT.STRFRY_EXEC_PATH, execParams),
  );
};

/**
 * strfryからkind:0を取得する
 * @param {string} pubkey kind:0を取得する公開鍵
 * @returns {Event}
 */
const strfryGetMetadata = (pubkey: string): Event => {
  const reqFilter = {
    authors: [pubkey],
    kinds: [0],
    limit: 1,
  };
  const execParams = ["scan", JSON.stringify(reqFilter)];

  const execOut = childProcess.execFileSync(
    ENVIRONMENT.STRFRY_EXEC_PATH,
    execParams,
  );
  const userInfo = execOut.toString();
  return JSON.parse(userInfo ?? "{}");
};

/**
 * bcを実行する
 * @param {string} input
 * @returns {Promise<string>}
 */
const bcGetOutput = async (input: string): Promise<string> => {
  const TIMEOUT = 5 * 1000;
  const execParams = ["-l", "-s"];

  const execOpts: childProcess.CommonSpawnOptions = {
    stdio: ["pipe", "pipe", "ignore"],
  };

  const strfryProcess = childProcess.spawn("bc", execParams, execOpts);

  setTimeout(() => strfryProcess.kill(15), TIMEOUT);

  const rl = readline.createInterface({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    input: strfryProcess.stdout!,
    crlfDelay: Infinity,
  });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  strfryProcess.stdin!.write(`${input}\n`);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  strfryProcess.stdin!.end();

  let output = "";
  for await (const line of rl) {
    output += `${line}\n`;
  }

  return output.trim();
};

/**
 * btcからsatへの単位変換
 * @param {number} btc
 * @returns {number}
 */
const btc2sat = (btc: number): number => {
  return btc * 100000000;
};

/**
 *
 * @param {number} sat
 * @returns {number}
 */
const sat2btc = (sat: number): number => {
  return sat * 0.00000001;
};

/* 暴走・無限リプライループ対策 */
// リプライクールタイム
const COOL_TIME_DUR_SEC = 5;

// 公開鍵ごとに、最後にリプライを返した時刻(unixtime)を保持するMap
const lastReplyTimePerPubkey = new Map();

/**
 * 引数のイベントにリプライしても安全か?
 * 対象の発行時刻が古すぎる場合・最後にリプライを返した時点からクールタイム分の時間が経過していない場合、安全でない
 * @param {Event} event
 * @returns {boolean}
 */
const isSafeToReply = (event: Event): boolean => {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { pubkey, created_at } = event;
  const now = currUnixtime();
  if (created_at < now - COOL_TIME_DUR_SEC) {
    return false;
  }

  const lastReplyTime = lastReplyTimePerPubkey.get(pubkey);
  if (lastReplyTime !== undefined && now - lastReplyTime < COOL_TIME_DUR_SEC) {
    return false;
  }
  lastReplyTimePerPubkey.set(pubkey, now);
  return true;
};

/**
 *
 * @returns {string}
 */
const greetingMessage = (): string => {
  const hour = getHours(new Date());
  let message = "";
  if (hour >= 4 && hour < 11) {
    message = "おはようございます！";
  } else if (hour >= 11 && hour < 17) {
    message = "こんにちは！";
  } else {
    message = "こんばんは！";
  }
  return message;
};

/**
 *
 * @returns {MemoryData}
 */
const loadMemory = (): MemoryData => {
  if (!fs.existsSync(ENVIRONMENT.MEMORY_FILE)) {
    saveMemory(new Map() as MemoryData);
  }
  console.log("読み込み開始...");
  const memoryData = JSON.parse(
    fs.readFileSync(ENVIRONMENT.MEMORY_FILE, "utf-8"),
  );
  console.log("読み込み成功!");
  return new Map(memoryData);
};

/**
 *
 * @param {MemoryData} memoryData
 * @returns {void}
 */
const saveMemory = (memoryData: MemoryData): void => {
  fs.writeFileSync(ENVIRONMENT.MEMORY_FILE, JSON.stringify([...memoryData]));
  console.log("保存しました");
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdPing = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(ping): " + ev.content);

  const replyPost = composeReplyPost("pong!", ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdDiceMulti = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(さいころ指定): " + ev.content);

  const matchContentDice = ev.content.match(REGEX_DICE_MULTI);
  const diceCount = Number(matchContentDice?.[2] ?? 0);
  const diceNum = Number(matchContentDice?.[3] ?? 0);

  let replyPost;
  console.log(diceCount + "D" + diceNum);
  if (diceCount >= 1 && diceCount <= 100 && diceNum >= 1 && diceNum <= 10000) {
    let rollNum = 0;
    const rollList = [];
    for (let i = 0; i < diceCount; i++) {
      const rollNow = Math.floor(Math.random() * diceNum) + 1;
      rollNum += rollNow;
      rollList[i] = rollNow;
    }
    replyPost = composeReplyPost(
      `${rollList.join("+")} = ${rollNum} が出ました`,
      ev,
    );
  } else {
    replyPost = composeReplyPost("数えられない…", ev);
  }
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdDiceSingle = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(さいころ1D6): " + ev.content);

  const rollNum = Math.floor(Math.random() * 6) + 1;
  const replyPost = composeReplyPost(rollNum + "が出ました", ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdReaction = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(星投げ)");

  const reaction = emoji.random().emoji;
  const replyPost = composeReplyPost(
    CONST.AA_LIST[Math.floor(Math.random() * CONST.AA_LIST.length)].replace(
      "Z",
      reaction,
    ),
    ev,
  );
  await publishToRelay(relay, replyPost);
  await publishToRelay(relay, composeReaction(reaction, ev));

  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdCount = async (
  _systemData: SystemData,
  userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(カウンタ): " + ev.content);

  if (userData.counter !== undefined) {
    userData.counter++;
  } else {
    userData.counter = 1;
  }
  const replyPost = composeReplyPost(userData.counter + "回目です", ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdLoginbonus = async (
  _systemData: SystemData,
  userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(ログボ): " + ev.content);

  let message = "";
  if (ev.created_at >= currUnixtime() + 10) {
    // 時間が10秒以上先
    message = "未来からログインしないで！";
  } else {
    // 正常なイベント
    if (userData.loginBonus !== undefined) {
      // 既存ユーザー
      const loginBonus = userData.loginBonus;
      const lastLoginTime = fromUnixTime(loginBonus.lastLoginTime ?? 0);
      const currentDay = new Date(new Date().setHours(0, 0, 0, 0));
      const yesterDay = subDays(currentDay, 1);
      if (lastLoginTime < currentDay) {
        // ログボ発生
        console.log("ログボ発生");
        if (lastLoginTime < yesterDay) {
          // 昨日ログインしていないので連続回数リセット
          loginBonus.consecutiveLoginCount = 0;
        }
        loginBonus.totalLoginCount++;
        loginBonus.consecutiveLoginCount++;
        loginBonus.lastLoginTime = ev.created_at;
        // ユーザーデータ保存
        userData.loginBonus = loginBonus;

        message =
          `${greetingMessage()}\n` +
          `あなたの合計ログイン回数は${loginBonus.totalLoginCount}回です。\n` +
          `あなたの連続ログイン回数は${loginBonus.consecutiveLoginCount}回です。`;
      } else {
        // すでにログイン済
        console.log("すでにログイン済");
        message =
          `今日はもうログイン済みです。\n` +
          `あなたの合計ログイン回数は${loginBonus.totalLoginCount}回です。\n` +
          `あなたの連続ログイン回数は${loginBonus.consecutiveLoginCount}回です。`;
      }
    } else {
      // 新規ユーザー
      console.log("新規ユーザー");
      const loginBonus: LoginBonus = {
        lastLoginTime: ev.created_at,
        consecutiveLoginCount: 1,
        totalLoginCount: 1,
      };
      // ユーザーデータ保存
      userData.loginBonus = loginBonus;
      message = "はじめまして！\n最初のログインです";
    }
  }
  // メッセージ送信
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdUnixtime = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(unixtime): " + ev.content);

  const replyPost = composeReplyPost(`現在は${currUnixtime() + 1}です。`, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdBlocktime = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(blocktime): " + ev.content);

  let message = "";
  message = await axios
    .get("https://mempool.space/api/blocks/tip/height")
    .then((response) => `現在のblocktimeは${response.data}です。`)
    .catch((err) => {
      console.log(err);
      return "取得に失敗しました…";
    });

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);

  return true;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdFiatConv = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(通貨変換): " + ev.content);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const currencyData = systemData.currencyData ?? ({} as CurrencyData);

  const args = ev.content.match(REGEX_FIATCONV)?.[2].split(" ") ?? [];
  const command =
    (args[0] ?? "").match(/(yen|jpy)/i) != null
      ? "jpy"
      : (args[0] ?? "").match(/(dollar|usd)/i) != null
        ? "usd"
        : (args[0] ?? "").match(/(sat)/i) != null
          ? "sat"
          : (args[0] ?? "").match(/(btc|bitcoin)/i) != null
            ? "btc"
            : "";
  const price = Number(args.splice(1).join(" "));

  const updateAt = format(
    fromUnixTime(currencyData.updateAt),
    "yyyy-MM-dd HH:mm",
  );
  let sat, btc, usd, jpy;

  let message = "わかりませんでした…";
  switch (command) {
    case "sat":
      sat = price;
      usd = sat2btc(sat) * currencyData.btc2usd;
      jpy = sat2btc(sat) * currencyData.btc2jpy;

      message = `丰${sat} は 日本円で${jpy}、USドルで${usd}でした！\nupdate at: ${updateAt}\nPowered by CoinGecko`;
      break;
    case "btc":
      btc = price;
      usd = btc * currencyData.btc2usd;
      jpy = btc * currencyData.btc2jpy;

      message = `₿${btc} は 日本円で${jpy}、USドルで${usd}でした！\nupdate at: ${updateAt}\nPowered by CoinGecko`;
      break;
    case "jpy":
      jpy = price;
      usd = jpy / currencyData.usd2jpy;
      sat = btc2sat(jpy / currencyData.btc2jpy);
      message = `￥${jpy} は Satoshiで${sat}、USドルで${usd}でした！\nupdate at: ${updateAt}\nPowered by CoinGecko`;
      break;
    case "usd":
      usd = price;
      jpy = usd * currencyData.usd2jpy;
      sat = btc2sat(usd / currencyData.btc2usd);
      message = `＄${usd} は Satoshiで${sat}、日本円で${jpy}でした！\nupdate at: ${updateAt}\nPowered by CoinGecko`;
      break;
  }
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdSatConv = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const currencyData = systemData.currencyData ?? ({} as CurrencyData);
  if (currencyData.updateAt === 0) return false;

  console.log("発火(satconv): " + ev.content);

  const sat = Number(ev.content.match(REGEX_SATCONV)?.[2] ?? 0);
  const usd = sat2btc(sat) * currencyData.btc2usd;
  const jpy = sat2btc(sat) * currencyData.btc2jpy;
  const updateAt = format(
    fromUnixTime(currencyData.updateAt),
    "yyyy-MM-dd HH:mm",
  );
  const message = `丰${sat} = ￥${jpy} ＄${usd}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdJpyConv = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const currencyData = systemData.currencyData ?? ({} as CurrencyData);
  if (currencyData.updateAt === 0) return false;

  console.log("発火(jpyconv): " + ev.content);

  const jpy = Number(ev.content.match(REGEX_JPYCONV)?.[2] ?? 0);
  const usd = jpy / currencyData.usd2jpy;
  const sat = btc2sat(jpy / currencyData.btc2jpy);
  const updateAt = format(
    fromUnixTime(currencyData.updateAt),
    "yyyy-MM-dd HH:mm",
  );
  const message = `￥${jpy} = 丰${sat} ＄${usd}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdUsdConv = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const currencyData = systemData.currencyData ?? ({} as CurrencyData);
  if (currencyData.updateAt === 0) return false;

  console.log("発火(usdconv): " + ev.content);

  const usd = Number(ev.content.match(REGEX_USDCONV)?.[2] ?? 0);
  const jpy = usd * currencyData.usd2jpy;
  const sat = btc2sat(usd / currencyData.btc2usd);
  const updateAt = format(
    fromUnixTime(currencyData.updateAt),
    "yyyy-MM-dd HH:mm",
  );
  const message = `＄${usd} = 丰${sat} ￥${jpy}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdRemind = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(リマインダ): " + ev.content);
  let message = "";
  const reminderList = systemData.reminderList ?? [];

  const reminderCommand = ev.content.match(REGEX_REMIND)?.[2] ?? "";

  const REGEX_REMIND_LIST = /^(list)$/i;
  const REGEX_REMIND_DELETE = /^(del)\s(.+)$/i;
  if (reminderCommand.match(REGEX_REMIND_LIST) != null) {
    message = "あなた宛に現在登録されている通知予定は以下の通りです！\n";
    const filteredList = reminderList.filter(
      (record) => record.eventPubkey === ev.pubkey,
    );
    if (filteredList.length === 0) {
      message += "見つかりませんでした…";
    } else {
      filteredList.forEach((record) => {
        // eslint-disable-next-line prettier/prettier
        const notifyDate = format(
          new Date(record.remindAt),
          "yyyy-MM-dd HH:mm",
        );
        const notifyNote = nip19.noteEncode(record.eventId);
        message += `${notifyDate} => nostr:${notifyNote}\n`;
      });
    }
  } else if (reminderCommand.match(REGEX_REMIND_DELETE) !== null) {
    const deleteWord = (
      reminderCommand.match(REGEX_REMIND_DELETE)?.[2] ?? ""
    ).replace("nostr:", "");

    if (deleteWord.length > 0) {
      const deleteQuery =
        deleteWord.match(nip19.BECH32_REGEX) !== null
          ? nip19.decode(deleteWord).data
          : deleteWord;
      systemData.reminderList = reminderList.filter(
        (record) =>
          !(record.eventPubkey === ev.pubkey && record.eventId === deleteQuery),
      );

      const noteId = nip19.noteEncode(deleteQuery as string);
      message = `指定されたノート( nostr:${noteId} )宛てにあなたが作成した通知を全て削除しました！`;
    }
  } else {
    const pos = reminderCommand.indexOf("!!!");
    const reminderDateText = (
      pos === -1 ? reminderCommand : reminderCommand.substring(0, pos)
    ).trim();
    const reminderContent = (
      pos === -1 ? "" : reminderCommand.substring(pos + 3)
    ).trim();
    const reminderDate =
      chrono.parseDate(
        reminderDateText,
        { instant: new Date() },
        { forwardDate: true },
      ) ??
      chrono.parseDate(
        `next ${reminderDateText}`,
        { instant: new Date() },
        { forwardDate: true },
      ) ??
      fromUnixTime(0);

    if (reminderDate > new Date()) {
      const record = {
        remindAt: reminderDate.getTime(),
        eventId: ev.id,
        eventPubkey: ev.pubkey,
        eventKind: ev.kind,
        eventTags: ev.tags.filter((x: any[]) => x[0] === "e"),
        content: reminderContent,
      };
      reminderList.push(record);
      systemData.reminderList = reminderList;
      message =
        format(reminderDate, "yyyy-MM-dd HH:mm") + "になったらお知らせします！";
    } else {
      message = "正しく処理できませんでした…";
    }
  }
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);

  return true;
};

/**
 *
 * @param {string} location
 * @returns {Promise<any>}
 */
// TODO: any剥がす
const getLocation = async (location: string): Promise<any> => {
  if (location.length === 0) return JSON.parse("{}");

  return (
    await axios.get(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${location}`,
    )
  ).data;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdLocation = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(場所): " + ev.content);
  const location =
    ev.content.match(REGEX_LOCATION) != null
      ? ev.content.match(REGEX_LOCATION)?.[2]
      : ev.content.match(REGEX_LOCATION_ALT) != null
        ? ev.content.match(REGEX_LOCATION_ALT)?.[1]
        : "";
  let message = "わかりませんでした…";
  if (location !== undefined && location.length !== 0) {
    const geoDataItems = await getLocation(location);
    if (geoDataItems.length !== 0) {
      const geoData = geoDataItems[0];
      message = `${location}は${geoData.properties.title}にあるみたいです！`;
    }
  }

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {string} location
 * @returns {Promise<string>}
 */
const messageWeatherForecast = async (location: string): Promise<string> => {
  let message = "";
  try {
    const geoDataItems = await getLocation(location);
    if (geoDataItems.length === 0) return "知らない場所です…";
    const geoData = geoDataItems[0];

    console.log(geoData);
    message += `${geoData.properties.title}の天気です！ (気象庁情報)\n`;
    const coordinates = geoData.geometry.coordinates;
    const addressData = (
      await axios.get(
        `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lon=${coordinates[0]}&lat=${coordinates[1]}`,
      )
    ).data;
    console.log(addressData.results);
    const muniCode = addressData.results.muniCd + "00";
    console.log(muniCode);
    const areaData = (
      await axios.get(`https://www.jma.go.jp/bosai/common/const/area.json`)
    ).data;

    const class20sData = Object.entries(areaData.class20s).sort(
      (left, right) => {
        if (Number(left[0]) < Number(right[0])) return -1;
        if (Number(left[0]) > Number(right[0])) return 1;
        return 0;
      },
    );

    let left = 0;
    let mid = 0;
    let right = class20sData.length;

    while (right - left > 1) {
      mid = Math.floor((left + right) / 2);
      if (Number(muniCode) === Number(class20sData[mid][0])) break;
      else if (Number(muniCode) > Number(class20sData[mid][0])) left = mid;
      else right = mid;
    }
    if (Number(muniCode) < Number(class20sData[mid][0])) mid--;

    // TODO: any剥がす
    const class15sCode = (class20sData as any[])[mid][1].parent;
    console.log(class15sCode);
    // TODO: any剥がす
    const class10sCode = (Object.entries(areaData.class15s) as any[]).filter(
      (record) => record[0] === class15sCode,
    )[0][1].parent;
    console.log(class10sCode);
    // TODO: any剥がす
    const officesCode = (Object.entries(areaData.class10s) as any[]).filter(
      (record) => record[0] === class10sCode,
    )[0][1].parent;
    console.log(officesCode);

    const forecastUrl = "https://www.jma.go.jp/bosai/forecast/data/forecast/";
    const response = await axios.get(`${forecastUrl}${officesCode}.json`);

    let arrayId = 0;
    for (let i = 0; i < response.data[0].timeSeries[0].areas.length; i++) {
      if (response.data[0].timeSeries[0].areas[i].area.code === class10sCode) {
        arrayId = i;
        break;
      }
    }

    const forecastsShort = response.data[0].timeSeries;

    const forecastsShortTemps = forecastsShort[2].areas[arrayId].temps;
    if (getHours(new Date()) >= 9 && getHours(new Date()) < 18)
      forecastsShortTemps.splice(1, 1);
    const forecastsShortTempsLength = forecastsShortTemps.length;
    for (let i = 0; i < 4 - forecastsShortTempsLength; i++)
      forecastsShortTemps.unshift("--");

    // TODO: any剥がす
    const forecastShortPops = forecastsShort[1].areas[arrayId].pops.map(
      (element: any) => element.padStart(3, " ") + "%",
    );
    const forecastShortPopsLength = forecastShortPops.length;
    for (let i = 0; i < 8 - forecastShortPopsLength; i++) {
      forecastShortPops.unshift("----");
    }

    const forecastsLong = response.data[1].timeSeries;
    const timeDefinesLong = forecastsLong[0].timeDefines;
    const forecastLongAreas = [];
    for (let i = 0; i < forecastsLong[0].areas.length; i++) {
      forecastLongAreas[i] = {
        weather: forecastsLong[0].areas[i],
        amedas: forecastsLong[1].areas[i],
      };
    }

    const area = forecastLongAreas[arrayId];
    // eslint-disable-next-line prettier/prettier
    message += `${format(
      new Date(forecastsShort[0].timeDefines[0]),
      "yyyy-MM-dd",
    )} ${forecastsShortTemps[0]}/${forecastsShortTemps[1]} ${
      forecastsShort[0].areas[arrayId].weathers[0]
    }\n`;
    message += `降水確率: ${[...forecastShortPops].slice(0, 4).join(" / ")}\n`;
    // eslint-disable-next-line prettier/prettier
    message += `${format(
      new Date(forecastsShort[0].timeDefines[1]),
      "yyyy-MM-dd",
    )} ${forecastsShortTemps[2]}/${forecastsShortTemps[3]} ${
      forecastsShort[0].areas[arrayId].weathers[1]
    }\n`;
    message += `降水確率: ${[...forecastShortPops].slice(4).join(" / ")}\n`;

    message += "---------------\n";

    for (let i = 2; i < timeDefinesLong.length; i++) {
      // eslint-disable-next-line prettier/prettier
      message += `${format(new Date(timeDefinesLong[i]), "yyyy-MM-dd")} (${
        area.weather.reliabilities[i]
      }) ${area.amedas.tempsMin[i]}/${area.amedas.tempsMax[i]} ${
        area.weather.pops[i]
      }% ${CONST.TELOPS[area.weather.weatherCodes[i]][3]}\n`;
    }

    message += "---------------\n";

    const forecastData = (
      await axios.get(
        `https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${officesCode}.json`,
      )
    ).data;
    console.log(forecastData.text);
    message += forecastData.text;
  } catch (e) {
    console.log(e);
    message = "何か問題が発生しました…";
  }
  return message;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdWeatherAltForecast = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(天気Alt予報): " + ev.content);
  const location = ev.content.match(REGEX_WEATHER_ALT_FORECAST)?.[1] ?? "";
  let message = "場所が不明です…";
  if (location.length !== 0) message = await messageWeatherForecast(location);

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdWeatherAltMap = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(天気図Alt): " + ev.content);

  const message = await messageWeatherMap();
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @returns {Promise<string>}
 */
const messageWeatherMap = async (): Promise<string> => {
  let message = "現在の天気図です！\n";
  const mapList = (
    await axios.get("https://www.jma.go.jp/bosai/weather_map/data/list.json")
  ).data.near.now;
  message +=
    "https://www.jma.go.jp/bosai/weather_map/data/png/" + mapList.slice(-1)[0];
  return message;
};

/**
 *
 * @param {SystemData} systemData
 * @returns {Promise<string>}
 */
const messageWeatherHimawari = async (
  systemData: SystemData,
): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const himawariCache = systemData.himawariCache ?? ({} as HimawariCache);
  let message = "";

  const lastHimawariDate = fromUnixTime(himawariCache.lastHimawariDate ?? 0);
  let himawariUrl = "";
  const fdData = await getLatestHimawariTime();
  const currentHimawariDate = parse(
    fdData.basetime + "Z",
    "yyyyMMddHHmmssX",
    new Date(),
  );
  if (currentHimawariDate > lastHimawariDate) {
    console.log("生成");
    himawariUrl = await generateHimawariImage(fdData);
    console.log("生成完了: " + himawariUrl);
    himawariCache.lastHimawariDate = getUnixTime(currentHimawariDate);
    himawariCache.lastHimawariUrl = himawariUrl;
  } else {
    himawariUrl = himawariCache.lastHimawariUrl;
  }
  const dateText = format(currentHimawariDate, "yyyy-MM-dd HH:mm");
  message = `${dateText}現在の気象衛星ひまわりの画像です！\n`;
  message += himawariUrl;
  systemData.himawariCache = himawariCache;
  return message;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdWeatherAltHimawari = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(天気Altひまわり): " + ev.content);

  const message = await messageWeatherHimawari(systemData);
  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {string} title
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
const uploadToChevereto = async (
  title: string,
  buffer: Buffer,
): Promise<string> => {
  const form = new FormData();
  form.append("source", buffer.toString("base64"));
  form.append("title", title);
  form.append("album_id", ENVIRONMENT.CHEVERETO_ALBUM_ID);
  form.append("format", "json");
  const config = {
    headers: {
      "X-API-Key": ENVIRONMENT.CHEVERETO_API_KEY,
      ...form.getHeaders(),
    },
  };

  const result = (
    await axios.post(
      ENVIRONMENT.CHEVERETO_BASE_URL + "/api/1/upload",
      form,
      config,
    )
  ).data;
  return result.image.url;
};

/**
 *
 * @returns {Promise<{ basetime: string; validtime: any; }>}
 */
const getLatestHimawariTime = async (): Promise<{
  basetime: string;
  validtime: any;
}> => {
  const fdDataItems = (
    await axios.get(
      "https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json",
    )
  ).data;
  return fdDataItems.slice(-1)[0];
};

/**
 *
 * @param fdData
 * @returns {Promise<string>}
 */
const generateHimawariImage = async (fdData: {
  basetime: string;
  validtime: any;
}): Promise<string> => {
  const tileBaseUrl = `https://www.jma.go.jp/bosai/himawari/data/satimg/${fdData.basetime}/fd/${fdData.validtime}/B13/TBB/`;
  const tileOverlayUrl = "https://www.jma.go.jp/tile/jma/sat/";

  const options = {
    width: 1024,
    height: 1024,
    tileLayers: [
      { tileUrl: tileBaseUrl + "{z}/{x}/{y}.jpg" },
      { tileUrl: tileOverlayUrl + "{z}/{x}/{y}.png" },
    ],
  };

  const map = new StaticMaps(options);
  await map.render([137, 34.5], 5);
  const mapBuffer = await map.image.buffer("image/webp");

  const url = await uploadToChevereto("himawari-" + fdData.basetime, mapBuffer);
  return url;
};

/**
 *
 * @param {{ basetime: string; validtime: string; }} targetTime
 * @param {number[]} coordinates
 * @returns {Promise<string>}
 */
const generateRadarImage = async (
  targetTime: { basetime: string; validtime: string },
  coordinates: number[],
): Promise<string> => {
  const ZOOM_LEVEL = 9;
  const tileBaseUrl = "https://www.jma.go.jp/tile/gsi/pale/";
  const tileBorderUrl =
    "https://www.jma.go.jp/bosai/jmatile/data/map/none/none/none/surf/mask/";
  const tileRadarUrl = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${targetTime.basetime}/none/${targetTime.validtime}/surf/hrpns/`;

  const options = {
    width: 1024,
    height: 1024,
    tileLayers: [
      {
        tileUrl: tileBaseUrl + "{z}/{x}/{y}.png",
      },
      {
        tileUrl: tileRadarUrl + "{z}/{x}/{y}.png",
      },
      {
        tileUrl: tileBorderUrl + "{z}/{x}/{y}.png",
      },
    ],
  };

  const map = new StaticMaps(options);

  await map.render([coordinates[0], coordinates[1]], ZOOM_LEVEL);
  const mapBuffer = await map.image.buffer("image/webp");

  const url = await uploadToChevereto("radar-" + currUnixtime(), mapBuffer);
  return url;
};

/**
 *
 * @returns {Promise<any>}
 */
// TODO: any剥がす
const getLatestRadarTime = async (): Promise<any> => {
  const targetTimes = (
    await axios.get(
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json",
    )
  ).data;
  return targetTimes[0];
};

/**
 *
 * @param {string} location
 * @returns {Promise<string>}
 */
const messageWeatherRadar = async (location: string): Promise<string> => {
  let message = "";
  try {
    const geoDataItems = await getLocation(location);
    if (geoDataItems.length === 0) return "知らない場所です…";
    const geoData = geoDataItems[0];

    console.log(geoData);
    message += `${geoData.properties.title}付近の雨雲の状態です！ (気象庁情報)\n`;
    const coordinates = geoData.geometry.coordinates;
    const targetTime = await getLatestRadarTime();
    message += await generateRadarImage(targetTime, coordinates);
  } catch (e) {
    console.log(e);
    message = "何か問題が発生しました…";
  }
  return message;
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdWeather = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(天気): " + ev.content);
  const args = ev.content.match(REGEX_WEATHER)?.[2].split(" ") ?? [];

  let message = "";
  let location = "";

  const command = args[0] ?? "";
  switch (command) {
    case "forecast":
      location = args.splice(1).join(" ");
      if (location.length !== 0)
        message = await messageWeatherForecast(location);
      else message = "場所が不明です…";
      break;

    case "map":
      message = await messageWeatherMap();
      break;

    case "himawari":
      message = await messageWeatherHimawari(systemData);
      break;

    case "radar":
      location = args.splice(1).join(" ");
      if (location.length !== 0) message = await messageWeatherRadar(location);
      else message = "場所が不明です…";
      break;

    default:
      message = "コマンドが不明です…";
      break;
  }

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);

  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdCalculator = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(電卓): " + ev.content);
  const formula = ev.content.match(REGEX_CALCULATOR)?.[2] ?? "";
  let message = "式が不明です…";
  if (formula.length !== 0) message = await bcGetOutput(formula);

  if (message.length === 0) message = "計算できませんでした…";
  else message = `結果は以下の通りです！\n${message}`;

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

const mClient = new MeiliSearch({
  host: "http://meilisearch:7700",
  apiKey: "99ebaa5184aecda61bd9fa569039cc8c1fc31b1dc88289f2355e857731bac1ef",
});
const mIndex = mClient.index("events");

/**
 *
 * @param {string}keyword
 * @returns {Promise<Hits>}
 */
const searchNotes = async (keyword: string): Promise<Hits> => {
  const result = await mIndex.search(`"${keyword}"`, {
    filter: ["kind = 1"],
    limit: 5,
  });
  return result.hits;
};

/**
 *
 * @param {string} keyword
 * @returns {Promise<string>}
 */
const messageSearchNotes = async (keyword: string): Promise<string> => {
  let message = "";
  const result = await searchNotes(keyword);
  result.forEach((data) => {
    message += `nostr:${nip19.noteEncode(data.id)}\n`;
  });
  return message;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdSearch = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(検索): " + ev.content);
  const keyword = ev.content.match(REGEX_SEARCH)?.[2] ?? "";
  let message = "よくわかりませんでした…";
  if (keyword.length !== 0) message = await messageSearchNotes(keyword);

  if (message.length === 0) message = "みつかりませんでした…";
  else message = `検索結果は以下の通りです！\n${message}`;

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdInfo = async (
  _systemData: SystemData,
  userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(情報): " + ev.content);
  if (userData.infoTimer === undefined) userData.infoTimer = 0;

  const timerDuration = currUnixtime() - userData.infoTimer;
  const COOLDOWN_TIMER = 10 * 60;
  if (timerDuration >= COOLDOWN_TIMER) {
    const metadata = strfryGetMetadata(ev.pubkey);
    console.log(metadata);
    let userName;
    let message;
    if (validateEvent(metadata) && verifySignature(metadata)) {
      const userInfo = JSON.parse(metadata.content);
      userName = userInfo.display_name ?? userInfo.displayName ?? undefined;
    }
    if (userName !== undefined)
      message = `${greetingMessage()} ${userName}さん！\n`;
    else message = `${greetingMessage()} (まだkind:0を受信していません)\n`;

    message +=
      "やぶみが把握しているあなたのイベントは以下の通りです。 (day, week, month, total)\n";

    const countNoteDay = strfryCount({
      authors: [ev.pubkey],
      kinds: [1],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countNoteWeek = strfryCount({
      authors: [ev.pubkey],
      kinds: [1],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countNoteMonth = strfryCount({
      authors: [ev.pubkey],
      kinds: [1],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countNoteTotal = strfryCount({ authors: [ev.pubkey], kinds: [1] });
    message += `投稿(kind: 1): ${countNoteDay}, ${countNoteWeek}, ${countNoteMonth}, ${countNoteTotal}\n`;

    const countRepostDay = strfryCount({
      authors: [ev.pubkey],
      kinds: [6],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countRepostWeek = strfryCount({
      authors: [ev.pubkey],
      kinds: [6],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countRepostMonth = strfryCount({
      authors: [ev.pubkey],
      kinds: [6],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countRepostTotal = strfryCount({ authors: [ev.pubkey], kinds: [6] });
    message += `リポスト(kind: 6): ${countRepostDay}, ${countRepostWeek}, ${countRepostMonth}, ${countRepostTotal}\n`;

    const countReactionDay = strfryCount({
      authors: [ev.pubkey],
      kinds: [7],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countReactionWeek = strfryCount({
      authors: [ev.pubkey],
      kinds: [7],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countReactionMonth = strfryCount({
      authors: [ev.pubkey],
      kinds: [7],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countReactionTotal = strfryCount({
      authors: [ev.pubkey],
      kinds: [7],
    });
    message += `リアクション(kind: 7): ${countReactionDay}, ${countReactionWeek}, ${countReactionMonth}, ${countReactionTotal}\n`;

    const countEventDay = strfryCount({
      authors: [ev.pubkey],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countEventWeek = strfryCount({
      authors: [ev.pubkey],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countEventMonth = strfryCount({
      authors: [ev.pubkey],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countEventTotal = strfryCount({ authors: [ev.pubkey] });
    message += `全てのイベント: ${countEventDay}, ${countEventWeek}, ${countEventMonth}, ${countEventTotal}`;

    const replyPost = composeReplyPost(message, ev);
    await publishToRelay(relay, replyPost);
    userData.infoTimer = currUnixtime();
  } else {
    const timerCooldown = COOLDOWN_TIMER - timerDuration;
    const message =
      "しばらく経ってからもう一度実行してください…\n" +
      `cooldown: ${timerCooldown}`;
    const replyPost = composeReplyPost(message, ev);
    await publishToRelay(relay, replyPost);
  }

  return true;
};

/**
 *
 * @param {Array<string>} events
 * @returns {Array<{ key: string, value: number }>}
 */
const countUserEvents = (
  events: string[],
): Array<{ key: string; value: number }> => {
  const users: Record<string, number> = {};
  for (const event of events) {
    const eventData: Event = JSON.parse(event);
    const userId = eventData.pubkey;
    if (users[userId] !== undefined) users[userId]++;
    else users[userId] = 1;
  }
  const userArray: Array<{ key: string; value: number }> = Object.keys(
    users,
  ).map((k) => ({ key: k, value: users[k] }));
  userArray.sort((left, right) => right.value - left.value);

  return userArray;
};

/**
 *
 * @param {Array<{ key: string, value: number }>} userList
 * @returns {string}
 */
const generateRanking = (
  userList: Array<{ key: string; value: number }>,
): string => {
  const rankingHeader = [
    "🥇",
    "🥈",
    "🥉",
    "④",
    "⑤",
    "⑥",
    "⑦",
    "⑧",
    "⑨",
    "⑩",
    "⑪",
    "⑫",
    "⑬",
    "⑭",
    "⑮",
    "⑯",
    "⑰",
    "⑱",
    "⑲",
    "⑳",
  ];

  const userArray = userList.splice(0, 20);

  let message = "";
  for (let index = 0; index < userArray.length; index++) {
    const user = userArray[index];

    const metadata = strfryGetMetadata(user.key);
    // console.log(metadata);
    const userInfo = JSON.parse(metadata.content ?? "{}");
    const userName = userInfo.display_name ?? userInfo.displayName ?? undefined;
    const userNpub = nip19.npubEncode(user.key);
    if (userName !== undefined)
      message += `${rankingHeader[index]} ${user.value} ${userName} (nostr:${userNpub})\n`;
    else message += `${rankingHeader[index]} ${user.value} nostr:${userNpub}\n`;
  }
  return message.trim();
};

/**
 *
 * @param {SystemData} systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdStatus = async (
  systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(ステータス): " + ev.content);
  if (systemData.statusTimer === undefined) systemData.statusTimer = 0;

  const timerDuration = currUnixtime() - systemData.statusTimer;

  const COOLDOWN_TIMER = 5 * 60;

  if (timerDuration >= COOLDOWN_TIMER) {
    // 前回から5分経っているので処理する
    let message = "";

    message += "やぶみリレーの統計情報です！\n";

    const events = await strfryScan({
      kinds: [1],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const userList = countUserEvents(events);

    message += `直近24時間でノート(kind: 1)を1回以上投稿したユーザー数は${
      userList.filter((record) => record.value >= 1).length
    }でした！\n`;
    message += `直近24時間でノート(kind: 1)を2回以上投稿したユーザー数は${
      userList.filter((record) => record.value >= 2).length
    }でした！\n`;
    message += `直近24時間でノート(kind: 1)を10回以上投稿したユーザー数は${
      userList.filter((record) => record.value >= 10).length
    }でした！\n`;
    message += `直近24時間でノート(kind: 1)を50回以上投稿したユーザー数は${
      userList.filter((record) => record.value >= 50).length
    }でした！\n`;
    message += `直近24時間でノート(kind: 1)を100回以上投稿したユーザー数は${
      userList.filter((record) => record.value >= 100).length
    }でした！\n`;

    message += "\n";

    message +=
      "全てのユーザーのイベントは以下の通りです。 (day, week, month, total)\n";

    const countMetadataDay = strfryCount({
      kinds: [0],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countMetadataWeek = strfryCount({
      kinds: [0],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countMetadataMonth = strfryCount({
      kinds: [0],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countMetadataTotal = strfryCount({ kinds: [0] });
    message += `メタデータ(kind: 0): ${countMetadataDay}, ${countMetadataWeek}, ${countMetadataMonth}, ${countMetadataTotal}\n`;

    const countNoteDay = strfryCount({
      kinds: [1],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countNoteWeek = strfryCount({
      kinds: [1],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countNoteMonth = strfryCount({
      kinds: [1],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countNoteTotal = strfryCount({ kinds: [1] });
    message += `投稿(kind: 1): ${countNoteDay}, ${countNoteWeek}, ${countNoteMonth}, ${countNoteTotal}\n`;

    const countRepostDay = strfryCount({
      kinds: [6],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countRepostWeek = strfryCount({
      kinds: [6],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countRepostMonth = strfryCount({
      kinds: [6],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countRepostTotal = strfryCount({ kinds: [6] });
    message += `リポスト(kind: 6): ${countRepostDay}, ${countRepostWeek}, ${countRepostMonth}, ${countRepostTotal}\n`;

    const countReactionDay = strfryCount({
      kinds: [7],
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countReactionWeek = strfryCount({
      kinds: [7],
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countReactionMonth = strfryCount({
      kinds: [7],
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countReactionTotal = strfryCount({ kinds: [7] });
    message += `リアクション(kind: 7): ${countReactionDay}, ${countReactionWeek}, ${countReactionMonth}, ${countReactionTotal}\n`;

    const countEventDay = strfryCount({
      since: getUnixTime(subDays(new Date(), 1)),
    });
    const countEventWeek = strfryCount({
      since: getUnixTime(subWeeks(new Date(), 1)),
    });
    const countEventMonth = strfryCount({
      since: getUnixTime(subMonths(new Date(), 1)),
    });
    const countEventTotal = strfryCount({});
    message += `全てのイベント: ${countEventDay}, ${countEventWeek}, ${countEventMonth}, ${countEventTotal}`;
    const replyPost = composeReplyPost(message, ev);
    await publishToRelay(relay, replyPost);
    systemData.statusTimer = currUnixtime();
  } else {
    const timerCooldown = COOLDOWN_TIMER - timerDuration;
    const replyPost = composeReplyPost(
      "しばらく経ってからもう一度実行してください…\nCooldown: " + timerCooldown,
      ev,
    );
    await publishToRelay(relay, replyPost);
  }

  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdGeneratePassport = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(通行許可証発行): " + ev.content);
  let message = "正しく処理できませんでした…";
  if (redis !== null) {
    const key = `passport-${ev.pubkey}`;
    const value = addDays(new Date(), 7).getTime();
    try {
      await redis.set(key, value);
      const passportDate = format(value, "yyyy-MM-dd HH:mm");
      message =
        "通行許可証を発行しました！\n" +
        `${passportDate} まで国外から書き込み可能になります！`;
    } catch (err) {
      console.log(err);
    }
  }

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdPushSetting = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(通知設定): " + ev.content);

  const args = ev.content.match(REGEX_PUSHSETTING)?.[2].split(" ") ?? [];
  const command =
    (args[0] ?? "").match(/(note|1)/i) != null
      ? "NOTE"
      : (args[0] ?? "").match(/(dm|4)/i) != null
        ? "DM"
        : (args[0] ?? "").match(/(channel|42)/i) != null
          ? "CHANNEL_MESSAGE"
          : (args[0] ?? "").match(/(zap|9735)/i) != null
            ? "ZAP"
            : "";
  const cmdBool = checkBool(args.splice(1).join(" "));
  let message = "";
  const messageSuffix = cmdBool ? "有効化しました！" : "無効化しました！";

  switch (command) {
    case "NOTE": {
      const key = `push-${ev.pubkey}-1`;
      await redis?.set(key, Number(cmdBool));
      message = `ノートの通知を${messageSuffix}`;
      break;
    }
    case "DM": {
      const key = `push-${ev.pubkey}-4`;
      await redis?.set(key, Number(cmdBool));
      message = `DMの通知を${messageSuffix}`;
      break;
    }
    case "CHANNEL_MESSAGE": {
      const key = `push-${ev.pubkey}-42`;
      await redis?.set(key, Number(cmdBool));
      message = `GROUP CHATの通知を${messageSuffix}`;
      break;
    }
    case "ZAP": {
      const key = `push-${ev.pubkey}-9735`;
      await redis?.set(key, Number(cmdBool));
      message = `Zapの通知を${messageSuffix}`;
      break;
    }
    default: {
      message = "問題が発生しました…";
    }
  }

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);
  return true;
};

/**
 *
 * @param {string|number} input
 * @returns {boolean}
 */
const checkBool = (input: string | number): boolean => {
  if (typeof input === "string") {
    if (input.match(/^(enable|on|true|1)$/i) != null) {
      return true;
    } else if (input.match(/^(disable|off|false|0)$/i) != null) {
      return false;
    }
  }
  throw new Error("not valid input");
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdReboot = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(再起動): " + ev.content);
  if (ev.pubkey === ENVIRONMENT.ADMIN_HEX) {
    const replyPost = composeReplyPost("💤", ev);
    await publishToRelay(relay, replyPost);
    process.exit(0);
  } else {
    const replyPost = composeReplyPost("誰？", ev);
    await publishToRelay(relay, replyPost);
  }
  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} _userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdHelp = async (
  _systemData: SystemData,
  _userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(ヘルプ): " + ev.content);
  let message =
    `${greetingMessage()} やぶみちゃんです！\n` +
    "現在は出来ることは以下の通りです！\n";

  message +=
    "(unixtime) : 現在のUnixTimeを表示します！\n" +
    "(blocktime) : 現在のブロックタイムを表示します！\n";

  message += "(count|カウント) : カウントを呼び出した回数を表示します！\n";

  message +=
    "(loginbonus|ログインボーナス|ログボ|ろぐぼ) : ログインボーナスです！\n";

  message += "(ping) : pong!と返信します！\n";

  message += "(fav|ふぁぼ|ファボ|祝福|星) : リアクションを送信します！\n";

  message +=
    "(remind) <希望時間> : 希望時間にリプライを送信します！\n" +
    "    例) remind 2023/12/23 06:00:00\n" +
    "        remind 06:00:00\n" +
    "        remind 2023/12/23 06:00:00 !!!おきて\n" +
    "  (remind) list : あなたが登録したリマインダ一覧を表示します！\n" +
    "  (remind) del <イベントID(hex|note)> : 指定されたノート宛てにあなたが登録したリマインダを削除します！\n";

  message += "(dice) [ダイスの数と面の数] : さいころを振ります！\n";

  message +=
    "(fiatconv) (sat|jpy|usd) <金額> : 通貨変換をします！(Powered by CoinGecko)\n";

  message +=
    "(location) <場所> : 指定された場所を探します！\n" +
    "<場所>はどこ : 上のエイリアスです！\n";

  message +=
    "(weather) forecast <場所> : 指定された場所の天気をお知らせします！(気象庁情報)\n" +
    "<場所>の天気 : 上のエイリアスです！\n";

  message +=
    "(weather) map : 現在の天気図を表示します！(気象庁情報)\n" +
    "天気図 : 上のエイリアスです！\n";

  message +=
    "(weather) himawari : 現在の気象衛星ひまわりの画像を表示します！(気象庁情報)\n" +
    "ひまわり : 上のエイリアスです！\n";

  message +=
    "(weather) radar <場所>: 指定された場所の現在の雨雲の画像を表示します！(気象庁情報)\n";

  message += "(calc) <式> : 入力された式を計算します！\n";

  message +=
    "(passport|許可証|パス) : 国外からでもアクセス出来るように許可証を発行します！\n";

  message +=
    "(search) <キーワード> : 入力されたキーワードをリレーから検索します！\n";

  message +=
    "(push) (note|dm|channel|zap) (enable|disable|true|false|on|off|1|0): やぶみ通知の設定を変更します！\n";

  message +=
    "(info|情報) : あなたの統計情報をやぶみリレーから確認します！\n" +
    "(status|ステータス) : やぶみリレーの統計情報を表示します！\n" +
    "(help|ヘルプ|へるぷ) : このメッセージを表示します！\n";

  const replyPost = composeReplyPost(message, ev);
  await publishToRelay(relay, replyPost);

  return true;
};

/**
 *
 * @param {SystemData} _systemData
 * @param {UserData} userData
 * @param {Relay} relay
 * @param {Event} ev
 * @returns {Promise<boolean>}
 */
const cmdUnknown = async (
  _systemData: SystemData,
  userData: UserData,
  relay: Relay,
  ev: Event,
): Promise<boolean> => {
  console.log("発火(知らない): " + ev.content);
  if (userData.failedTimer === undefined) userData.failedTimer = 0;

  if (currUnixtime() - userData.failedTimer >= 60 * 5) {
    // 前回から5分経っているので処理する
    const messageList = ["知らない", "わからない", "コマンド合ってる？"];
    const messageFooterList = ["…", "！", ""];
    const message =
      messageList[Math.floor(Math.random() * messageList.length)] +
      messageFooterList[Math.floor(Math.random() * messageFooterList.length)];
    const replyPost = composeReplyPost(message, ev);
    await publishToRelay(relay, replyPost);
  }
  userData.failedTimer = currUnixtime();
  return true;
};

const REGEX_PING = /\b(ping)\b/i;
const REGEX_REACTION = /(\bfav\b|ふぁぼ|ファボ|祝福|星)/i;

const REGEX_DICE_MULTI = /\b(dice)\s(\d+)d(\d+)\b/i;
const REGEX_DICE_SINGLE = /\b(dice)\b/i;

const REGEX_COUNT = /(\bcount\b|カウント)/i;
const REGEX_LOGINBONUS = /(\bloginbonus\b|ログインボーナス|ログボ|ろぐぼ)/i;

const REGEX_UNIXTIME = /\b(unixtime)\b/i;
const REGEX_BLOCKTIME = /\b(blocktime)\b/i;

const REGEX_LOCATION = /\b(location)\s(.+)/i;
const REGEX_LOCATION_ALT = /(\S+)はどこ/i;

const REGEX_WEATHER = /\b(weather)\s(.+)/i;
const REGEX_WEATHER_ALT_FORECAST = /(\S+)の天気/i;
const REGEX_WEATHER_ALT_MAP = /(天気図)/i;
const REGEX_WEATHER_ALT_HIMAWARI = /(ひまわり)/i;

const REGEX_SEARCH = /\b(search)\s(.*)/i;

const REGEX_REMIND = /\b(remind)\s(.+)/i;

const REGEX_FIATCONV = /\b(fiatconv)\s(.+)/i;
const REGEX_SATCONV = /\b(satconv)\s(\d+)\b/i;
const REGEX_JPYCONV = /\b(jpyconv)\s(\d+)\b/i;
const REGEX_USDCONV = /\b(usdconv)\s(\d+)\b/i;

const REGEX_CALCULATOR = /(calc)\s(.*)/is;

const REGEX_PASSPORT = /(\bpassport\b|許可証|パス)/i;

const REGEX_INFO = /(\binfo\b|情報)/i;
const REGEX_STATUS = /(\bstatus\b|ステータス)/i;

const REGEX_PUSHSETTING = /\b(push)\s(.+)/i;

const REGEX_REBOOT = /(\breboot\b|再起動)/i;
const REGEX_HELP = /(\bhelp\b|ヘルプ|へるぷ)/i;

// メイン関数
const main = async (): Promise<void> => {
  const memoryData = loadMemory();
  const systemData: SystemData = (memoryData.get("_") as SystemData) ?? {};

  const relay = relayInit(ENVIRONMENT.RELAY_URL);
  relay.on("error", () => {
    console.error("接続に失敗…");
    process.exit(0);
  });

  relay.on("disconnect", () => {
    console.error("切断されました…");
    process.exit(0);
  });

  await relay.connect();
  console.log("リレーに接続しました");

  const subAll = relay.sub([{ kinds: [1, 42], since: currUnixtime() }]);
  subAll.on("event", async (ev) => {
    if (ev.pubkey === getPublicKey(ENVIRONMENT.BOT_PRIVATE_KEY_HEX)) return; // 自分の投稿は無視する

    if (systemData.responseTimer === undefined) systemData.responseTimer = 0;
    let responseFlag = false;
    const timerDuration = currUnixtime() - systemData.responseTimer;
    const COOLDOWN_TIMER = 30;
    if (timerDuration >= COOLDOWN_TIMER) {
      if (ev.content.match(/^(823|823chan|やぶみちゃん|やぶみん)$/i) != null) {
        responseFlag = true;
        const post = composePost("👋", ev);
        await publishToRelay(relay, post);
      } else if (
        ev.content.match(/(ヤッブミーン|ﾔｯﾌﾞﾐｰﾝ|やっぶみーん)/i) != null
      ) {
        responseFlag = true;
        const message = "＼ﾊｰｲ!🙌／";
        const post = (() => {
          if (
            ev.content.match(/(ヤッブミーン|ﾔｯﾌﾞﾐｰﾝ|やっぶみーん)(!|！)/i) !=
            null
          )
            return composeReplyPost(message, ev);
          else return composePost(message, ev);
        })();

        await publishToRelay(relay, post);
      }

      if (responseFlag) systemData.responseTimer = currUnixtime();
    }
  });

  const sub = relay.sub([
    {
      kinds: [1, 42],
      "#p": [getPublicKey(ENVIRONMENT.BOT_PRIVATE_KEY_HEX)],
      since: currUnixtime(),
    },
  ]);

  sub.on("eose", async () => {
    console.log("****** EOSE ******");
    const duration = (currUnixtime() - START_TIME) / 1000;
    const post = composePost("準備完了！\nduration: " + duration + "sec.");
    await publishToRelay(relay, post);
  });

  // 0: Regexp pattern
  // 1: flag to call function even though wFlag is true
  // 2: command function
  // TODO: any剥がす
  const commands: any[] = [
    [REGEX_PING, true, cmdPing],
    [REGEX_DICE_MULTI, true, cmdDiceMulti],
    [REGEX_DICE_SINGLE, false, cmdDiceSingle],
    [REGEX_REACTION, true, cmdReaction],
    [REGEX_COUNT, true, cmdCount],
    [REGEX_LOGINBONUS, true, cmdLoginbonus],
    [REGEX_UNIXTIME, true, cmdUnixtime],
    [REGEX_BLOCKTIME, true, cmdBlocktime],
    [REGEX_FIATCONV, true, cmdFiatConv],
    [REGEX_SATCONV, true, cmdSatConv],
    [REGEX_JPYCONV, true, cmdJpyConv],
    [REGEX_USDCONV, true, cmdUsdConv],
    [REGEX_REMIND, true, cmdRemind],
    [REGEX_LOCATION, true, cmdLocation],
    [REGEX_LOCATION_ALT, true, cmdLocation],
    [REGEX_WEATHER, true, cmdWeather],
    [REGEX_WEATHER_ALT_FORECAST, true, cmdWeatherAltForecast],
    [REGEX_WEATHER_ALT_MAP, true, cmdWeatherAltMap],
    [REGEX_WEATHER_ALT_HIMAWARI, true, cmdWeatherAltHimawari],
    [REGEX_CALCULATOR, true, cmdCalculator],
    [REGEX_PASSPORT, true, cmdGeneratePassport],
    [REGEX_SEARCH, true, cmdSearch],
    [REGEX_INFO, true, cmdInfo],
    [REGEX_STATUS, true, cmdStatus],
    [REGEX_PUSHSETTING, true, cmdPushSetting],
    [REGEX_REBOOT, true, cmdReboot],
    [REGEX_HELP, false, cmdHelp],
  ];

  sub.on("event", async (ev) => {
    try {
      // リプライしても安全なら、リプライイベントを組み立てて送信する
      if (!isSafeToReply(ev)) return;

      console.log("なんかきた: " + ev.content);
      let wFlag = false;
      const userData =
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (memoryData.get(ev.pubkey) as UserData) ?? ({} as UserData);

      for (const command of commands) {
        if (ev.content.match(command[0]) === null) continue;
        if (!(command[1] as boolean) && wFlag) continue;
        wFlag = await command[2](systemData, userData, relay, ev);
      }

      if (!wFlag) await cmdUnknown(systemData, userData, relay, ev);

      memoryData.set(ev.pubkey, userData);
      memoryData.set("_", systemData);
    } catch (err) {
      console.error(err);
    }
  });

  // exit時
  process.on("exit", () => {
    saveMemory(memoryData);
    console.log("exit");
  });

  // Ctrl + C での終了を検知
  process.on("SIGINT", () => {
    console.log("SIGINT");
    saveMemory(memoryData);
    process.exit(0); // プロセスを正常終了させる
  });

  // Terminal が閉じられるのを検知
  process.on("SIGHUP", () => {
    console.log("SIGHUP");
    saveMemory(memoryData);
    process.exit(0); // プロセスを正常終了させる
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  cron.schedule("0 0 * * *", async () => {
    console.log("ランキング生成");
    const currentDay = new Date(new Date().setHours(0, 0, 0, 0));
    const yesterDay = subDays(currentDay, 1);
    const events = await strfryScan({
      kinds: [1, 6, 7],
      since: getUnixTime(yesterDay),
      until: getUnixTime(subSeconds(currentDay, 1)),
    });
    const userListKind1 = countUserEvents(
      events.filter((event) => JSON.parse(event).kind === 1),
    );
    const userListKind6 = countUserEvents(
      events.filter((event) => JSON.parse(event).kind === 6),
    );
    const userListKind7 = countUserEvents(
      events.filter((event) => JSON.parse(event).kind === 7),
    );

    console.log(
      `${format(yesterDay, "yyyy-MM-dd HH:mm")} → ${format(
        subSeconds(currentDay, 1),
        "yyyy-MM-dd HH:mm",
      )}`,
    );
    await publishToRelay(
      relay,
      composePost(
        `ノート(kind: 1)ランキングです！\n集計期間：${format(
          yesterDay,
          "yyyy-MM-dd HH:mm",
        )} → ${format(
          subSeconds(currentDay, 1),
          "yyyy-MM-dd HH:mm",
        )}\n\n${generateRanking(userListKind1)}`,
      ),
    );
    await publishToRelay(
      relay,
      composePost(
        `リポスト(kind: 6)ランキングです！\n集計期間：${format(
          yesterDay,
          "yyyy-MM-dd HH:mm",
        )} → ${format(
          subSeconds(currentDay, 1),
          "yyyy-MM-dd HH:mm",
        )}\n\n${generateRanking(userListKind6)}`,
      ),
    );
    await publishToRelay(
      relay,
      composePost(
        `リアクション(kind: 7)ランキングです！\n集計期間：${format(
          yesterDay,
          "yyyy-MM-dd HH:mm",
        )} → ${format(
          subSeconds(currentDay, 1),
          "yyyy-MM-dd HH:mm",
        )}\n\n${generateRanking(userListKind7)}`,
      ),
    );
  });

  cron.schedule("*/5 * * * *", () => {
    console.log("定期保存...");
    saveMemory(memoryData);
  });

  cron.schedule("*/5 * * * *", () => {
    // https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=jpy

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const currencyData = systemData.currencyData ?? ({} as CurrencyData);

    axios
      .get("https://api.coingecko.com/api/v3/exchange_rates")
      .then((response) => {
        currencyData.btc2usd = Number(response.data.rates.usd.value);
        currencyData.btc2jpy = Number(response.data.rates.jpy.value);
        currencyData.updateAt = currUnixtime();
        systemData.currencyData = currencyData;
        memoryData.set("_", systemData);
        console.log("BTCの価格を更新");
      })
      .catch((error) => {
        if (error.code === "ECONNABORTED") {
          console.log("取得失敗: タイムアウト");
          return;
        }
        const { status, statusText } = error.response;
        console.log(`取得失敗: ${status} ${statusText}`);
      });

    axios
      .get(
        "https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=jpy",
      )
      .then((response) => {
        currencyData.usd2jpy = Number(response.data.usd.jpy);
        currencyData.updateAt = currUnixtime();
        systemData.currencyData = currencyData;
        memoryData.set("_", systemData);
        console.log("USD/JPYの価格を更新");
      })
      .catch((error) => {
        if (error.code === "ECONNABORTED") {
          console.log("取得失敗: タイムアウト");
          return;
        }
        const { status, statusText } = error.response;
        console.log(`取得失敗: ${status} ${statusText}`);
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  cron.schedule("*/30 * * * * *", async () => {
    try {
      const reminderList = systemData.reminderList ?? [];
      const current = new Date().getTime();
      // 現在時刻より前のリマインダを探してforEachでリプライを送る
      await Promise.all(
        reminderList
          .filter((record) => record.remindAt <= current)
          .map(async (record) => {
            const ev = {
              id: record.eventId,
              pubkey: record.eventPubkey,
              kind: record.eventKind ?? 1,
              tags: record.eventTags ?? [],
              content: "",
              created_at: currUnixtime(),
              sig: "",
            };
            let message = "((🔔))";
            if (record.content !== undefined && record.content.length !== 0)
              message += " " + record.content;
            const replyPost = composeReplyPost(message, ev);
            await publishToRelay(relay, replyPost);
          }),
      );

      // リストお掃除
      systemData.reminderList = reminderList.filter(
        (record) => !(record.remindAt <= current),
      );

      // 保存
      memoryData.set("_", systemData);
    } catch (err) {
      console.error(err);
    }
  });

  if (ENVIRONMENT.HEALTHCHECK_URL.length !== 0) {
    cron.schedule("* * * * *", () => {
      axios
        .get(ENVIRONMENT.HEALTHCHECK_URL)
        .then((response) => {
          console.log(response.data);
        })
        .catch((error) => {
          if (error.code === "ECONNABORTED") {
            console.log("取得失敗: タイムアウト");
            return;
          }
          const { status, statusText } = error.response;
          console.log(`取得失敗: ${status} ${statusText}`);
        });
    });
  }
};

main().catch((e) => {
  console.error(e);
});
