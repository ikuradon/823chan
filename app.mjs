import {
  finishEvent,
  getPublicKey,
  nip19,
  relayInit,
  validateEvent,
  verifySignature,
} from "nostr-tools";
import "websocket-polyfill";

import "dotenv/config";

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";

import * as cron from "node-cron";
import axios from "axios";
import { format, fromUnixTime, getUnixTime, subDays, subMonths, subWeeks } from "date-fns";
import * as chrono from "chrono-node";

const currUnixtime = () => getUnixTime(new Date());
const START_TIME = currUnixtime();

const BOT_PRIVATE_KEY_HEX = process.env.PRIVATE_KEY_HEX;
const ADMIN_HEX = process.env.ADMIN_HEX;
const STRFRY_EXEC_PATH = process.env.STRFRY_EXEC_PATH || "/app/strfry";
const MEMORY_FILE = process.env.MEMORY_FILE || "./memory.json";

const relayUrl = "wss://yabu.me";

/**
 * テキスト投稿イベント(リプライ)を組み立てる
 * @param {string} content 投稿内容
 * @param {import("nostr-tools").Event} targetEvent リプライ対象のイベント
 */
const composeReplyPost = (content, targetEvent) => {
  const ev = {
    kind: 1,
    content: content,
    tags: [
      ["e", targetEvent.id],
      ["p", targetEvent.pubkey],
    ],
    created_at: currUnixtime() + 1,
  };

  // イベントID(ハッシュ値)計算・署名
  return finishEvent(ev, BOT_PRIVATE_KEY_HEX);
};

/**
 * テキスト投稿イベントを組み立てる
 * @param {string} content 
 */
const composePost = (content) => {
  const ev = {
    kind: 1,
    content: content,
    tags: [],
    created_at: currUnixtime() + 1,
  }

  // イベントID(ハッシュ値)計算・署名
  return finishEvent(ev, BOT_PRIVATE_KEY_HEX);
}

/**
 * リアクションイベントを組み立てる
 * @param {string} emoji リアクションで使う絵文字
 * @param {import("nostr-tools").Event} targetEvent リアクション対象のイベント
 */
const composeReaction = (emoji, targetEvent) => {
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
  return finishEvent(ev, BOT_PRIVATE_KEY_HEX);
};

// リレーにイベントを送信
const publishToRelay = (relay, ev) => {
  const pub = relay.publish(ev);
  pub.on("ok", () => {
    console.log("大根");
  });
  pub.on("failed", () => {
    console.log("人参");
  });
};

// strfryへコマンド実行する
const strfryScan = async (reqQuery) => {
  const execParams = [reqQuery];
  const execOptions = {
    shell: true,
  };

  const strfryProcess = childProcess.spawn(STRFRY_EXEC_PATH, execParams, execOptions);
  const rl = readline.createInterface({
    input: strfryProcess,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    console.log(line);
  }
};

/**
 * strfryからクエリしたイベントをカウントさせる
 * @param {JSON} reqQuery クエリ
 */
const strfryCount = (reqQuery) => {
  const execParams = [
    "scan",
    JSON.stringify(reqQuery),
    "--count",
  ];

  return Number(childProcess.execFileSync(STRFRY_EXEC_PATH, execParams));
};

/**
 * strfryからkind:0を取得する
 * @param {string} pubkey kind:0を取得する公開鍵
 */
const strfryGetMetadata = (pubkey) => {
  const reqQuery = {
    authors: [pubkey],
    kinds: [0],
    limit: 1,
  };
  const execParams = [
    "scan",
    JSON.stringify(reqQuery),
  ];

  const execOut = childProcess.execFileSync(STRFRY_EXEC_PATH, execParams);
  const userInfo = execOut.toString();
  return JSON.parse(userInfo || "{}");
}

const btc2sat = (btc) => {
  return btc * 100000000;
}

const sat2btc = (sat) => {
  return sat * 0.00000001;
}

/* 暴走・無限リプライループ対策 */
// リプライクールタイム
const COOL_TIME_DUR_SEC = 5;

// 公開鍵ごとに、最後にリプライを返した時刻(unixtime)を保持するMap
const lastReplyTimePerPubkey = new Map();

// 引数のイベントにリプライしても安全か?
// 対象の発行時刻が古すぎる場合・最後にリプライを返した時点からクールタイム分の時間が経過していない場合、安全でない
const isSafeToReply = ({ pubkey, created_at }) => {
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
}


const loadMemory = () => {
  if (!fs.existsSync(MEMORY_FILE)) {
    saveMemory(new Map());
  }
  console.log("読み込み開始...");
  const memoryData = JSON.parse(fs.readFileSync(MEMORY_FILE));
  console.log("読み込み成功!");
  return new Map(memoryData);
}

const saveMemory = (memoryData) => {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify([...memoryData]));
  console.log("保存しました");
}

// メイン関数
const main = async () => {
  const memoryData = loadMemory();
  const systemData = memoryData.get("_") || new Object();

  const relay = relayInit(relayUrl);
  relay.on("error", () => {
    console.error("接続に失敗…");
  });

  await relay.connect();
  console.log("リレーに接続しました");

  /* Q-2: 「このBotの公開鍵へのリプライ」を絞り込むフィルタを設定して、イベントを購読しよう */
  // ヒント: nostr-toolsのgetPublicKey()関数を使って、秘密鍵(BOT_PRIVATE_KEY_HEX)から公開鍵を得ることができます
  const sub = relay.sub([{ "kinds": [1], "#p": [getPublicKey(BOT_PRIVATE_KEY_HEX)], "since": currUnixtime() }]);


  // exit時
  process.on("exit", () => {
    saveMemory(memoryData);
    console.log("exit");
  });

  // Ctrl + C での終了を検知
  process.on("SIGINT", () => {
    console.log("SIGINT");
    saveMemory(memoryData);
    process.exit(0); //プロセスを正常終了させる
  });

  // Terminal が閉じられるのを検知
  process.on("SIGHUP", () => {
    console.log("SIGHUP");
    saveMemory(memoryData);
    process.exit(0); //プロセスを正常終了させる
  });

  cron.schedule("*/5 * * * *", () => {
    console.log("定期保存...");
    saveMemory(memoryData);
  });

  cron.schedule("*/5 * * * *", () => {
    try {
      // https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=jpy

      const currencyData = systemData.currencyData || new Object();

      axios.get("https://api.coingecko.com/api/v3/exchange_rates").then(response => {
        currencyData.btc2usd = Number(response.data.rates.usd.value);
        currencyData.btc2jpy = Number(response.data.rates.jpy.value);
        currencyData.updateAt = currUnixtime();
        systemData.currencyData = currencyData;
        memoryData.set("_", systemData);
        console.log("BTCの価格を更新");
      });

      axios.get("https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=jpy").then(response => {
        currencyData.usd2jpy = Number(response.data.usd.jpy);
        currencyData.updateAt = currUnixtime();
        systemData.currencyData = currencyData;
        memoryData.set("_", systemData);
        console.log("USD/JPYの価格を更新");
      });
    } catch (err) {
      console.error(err);
    }
  });

  cron.schedule("*/30 * * * * *", () => {
    try {
      const reminderList = systemData.reminderList || new Array();
      const current = new Date();
      // 現在時刻より前のリマインダを探してforEachでリプライを送る
      reminderList.filter(record => (record.remindAt <= current)).forEach(record => {
        const ev = {
          id: record.eventId,
          pubkey: record.eventPubkey,
        };
        const message = "((🔔))";
        const replyPost = composeReplyPost(message, ev);
        publishToRelay(relay, replyPost);
      });

      // リストお掃除
      systemData.reminderList = reminderList.filter(record => !(record.remindAt <= current));

      // 保存
      memoryData.set("_", systemData);
    } catch (err) {
      console.error(err);
    }
  });

  sub.on("eose", () => {
    console.log("****** EOSE ******");
    const duration = currUnixtime() - START_TIME;
    const post = composePost("準備完了！\nduration: " + duration);
    publishToRelay(relay, post);
  });

  sub.on("event", (ev) => {
    try {
      // リプライしても安全なら、リプライイベントを組み立てて送信する
      if (isSafeToReply(ev)) {
        console.log("なんかきた: " + ev.content);
        let wFlag = false;
        const userData = memoryData.get(ev.pubkey) || new Object();

        if (ev.content.match(/ping/gi)) {
          wFlag = true;
          console.log("発火(ping): " + ev.content);

          const replyPost = composeReplyPost("pong!", ev);
          publishToRelay(relay, replyPost);
        }

        if (ev.content.match(/dice\s(\d+)d(\d+)/gi)) {
          wFlag = true;
          console.log("発火(さいころ指定): " + ev.content);

          const matchContentDice = ev.content.match(/(\d+)d(\d+)/gi);
          const diceCount = Number(matchContentDice[0].match(/^(\d+)d(\d+)$/i)[1]);
          const diceNum = Number(matchContentDice[0].match(/^(\d+)d(\d+)$/i)[2]);
          console.log(diceCount + "D" + diceNum);
          if ((1 <= diceCount && diceCount <= 100) && (1 <= diceNum && diceNum <= 10000)) {
            let rollNum = 0;
            let rollList = [];
            for (let i = 0; i < diceCount; i++) {
              const rollNow = Math.floor(Math.random() * diceNum) + 1;
              rollNum += rollNow;
              rollList[i] = rollNow;
            }
            const replyPost = composeReplyPost(rollList.join("+") + "=" + rollNum + "が出ました", ev);
            publishToRelay(relay, replyPost);
          } else {
            const replyPost = composeReplyPost("数えられない…", ev);
            publishToRelay(relay, replyPost);
          }
        } else if (ev.content.match(/dice/gi)) {
          wFlag = true;
          console.log("発火(さいころ1D6): " + ev.content);

          const rollNum = Math.floor(Math.random() * 6) + 1;
          const replyPost = composeReplyPost(rollNum + "が出ました", ev);
          publishToRelay(relay, replyPost);
        }

        if (ev.content.match(/(fav|ふぁぼ|ファボ|祝福|星)/gi)) {
          wFlag = true;
          console.log("発火(星投げ)");

          const aaList = [
            "(   ･᷄ὢ･᷅ )╮=͟͟͞͞ Z",
            "( ∩ ˙-˙) =͟͟͞͞꜆꜄꜆ Z",
            "( ﾉ ´ ･ω･)ﾉ ⌒ Z ﾎﾟｲｯ!!",
            "( ﾉﾟД҂)ﾉ⌒Z ﾎﾟｲ",
            "(･x･ﾉ)ﾉ⌒ Z ﾎﾟｲｯ",
            "(｡-ω -｡)ﾉ ･ﾟﾟ･。Z ﾎﾟｲｯ",
            "(｡･ω･) σ ⌒ Z",
            "(* ﾉ･ω･) ﾉ⌒ Z ﾎﾟｲ",
            "(*・・)σ ⌒ Z ﾎﾟｲｯ",
            "(´・ω・`)っ⌒Z ぽーい",
            "(´っ･ω･)っ Z",
            "(Ｕ 'ᴗ')⊃≡ Z",
            "(っ･-･)⊃ ⌒Z ﾎﾟｲ",
            "(っ･-･)⊃ ⌒三 Z",
            "(っ'-')╮=͟͟͞͞ Z",
            "(っ'ヮ')╮ =͟͟͞͞三 Z",
            "(っ'ω')っ⌒Z ﾎﾟｲ",
            "(っ´∀`)╮ =͟͟͞͞ Z",
            "(っˊᵕˋ)╮=͟͟͞͞ Z",
            "(っ˶'ω')⊃ =͟͟͞͞ Z",
            "(ﾉ *ω*)ﾉ ⌒ Z ﾎﾟｲ♪",
            "(ﾉ*˙˘˙)ﾉ =͟͟͞͞ Z",
            "(ﾉﾟ∀ﾟ) ﾉ ⌒ Z",
            "(ﾉﾟДﾟ)ﾉ⌒ Z ﾎﾟｲ",
            "|'ω')ﾉ⌒ Z",
            "|'ω')ﾉ⌒゜Z ﾎﾟｲｯ",
            "╰( 　T□T)╮-=ﾆ=一＝三 Z",
            "╰(　`^´ )╮-=ﾆ=一＝三 Z",
            "╰( ^ o ^)╮-=ニ = Z",
            "╰( ͡° ͜ʖ ͡°)╮-｡･*･:≡ Z",
            "╰((#°Д°))╮ Z",
            "Z ･⌒ ヾ(*´ｰ｀) ﾎﾟｲ",
            "Z ･⌒ ヾ(*´ω`) ﾎﾟｲ",
            "Z ・⌒ヾ( ﾟ⊿ﾟ)ﾎﾟｲｯ",
            "Z \( '-'\* )ﾎﾟｲｯ",
            "Z ⌒ ヽ(´ｰ｀)",
            "Z ⌒⌒ ヽ(･ω･*ヽ)",
            "Z ⌒ヽ(･ω･* ヽ)",
            "Z ⌒ヽ(･ω･*ヽ)ﾎﾟｲ",
            "ｲﾗﾈ!(ﾟ∀ﾟ)ﾉ ⌒ Z ﾎﾟｨｯ",
            "ﾎﾟｲ(ﾉ˙³˙)ﾉ⌒ Z",
            "ﾎﾟｲｯ( ･ω･)ﾉ ⌒ Z",
            "ﾎﾟｲｯ('ω' )ﾉ⌒ Z",
            "三╰( `•ω•)╮-=ﾆ = 一＝三 Z",
          ];
          const emojiList = [
            '😄', '😃', '😀', '😊', '☺', '😉', '😍', '😘', '😚', '😗', '😙', '😜', '😝', '😛', '😳', '😁', '😔', '😌', '😒', '😞', '😣', '😢', '😂', '😭', '😪', '😥', '😰', '😅', '😓', '😩', '😫', '😨', '😱', '😠', '😡', '😤', '😖', '😆', '😋', '😷', '😎', '😴', '😵', '😲', '😟', '😦', '😧', '😈', '👿', '😮', '😬', '😐', '😕', '😯', '😶', '😇', '😏', '😑', '👲', '👳', '👮', '👷', '💂', '👶', '👦', '👧', '👨', '👩', '👴', '👵', '👱', '👼', '👸', '😺', '😸', '😻', '😽', '😼', '🙀', '😿', '😹', '😾', '👹', '👺', '🙈', '🙉', '🙊', '💀', '👽', '💩', '🔥', '✨', '🌟', '💫', '💥', '💢', '💦', '💧', '💤', '💨', '👂', '👀', '👃', '👅', '👄', '👍', '👎', '👌', '👊', '✊', '✌', '👋', '✋', '👐', '👆', '👇', '👉', '👈', '🙌', '🙏', '☝', '👏', '💪', '🚶', '🏃', '💃', '👫', '👪', '👬', '👭', '💏', '💑', '👯', '🙆', '🙅', '💁', '🙋', '💆', '💇', '💅', '👰', '🙎', '🙍', '🙇', '🎩', '👑', '👒', '👟', '👞', '👡', '👠', '👢', '👕', '👔', '👚', '👗', '🎽', '👖', '👘', '👙', '💼', '👜', '👝', '👛', '👓', '🎀', '🌂', '💄', '💛', '💙', '💜', '💚', '❤', '💔', '💗', '💓', '💕', '💖', '💞', '💘', '💌', '💋', '💍', '💎', '👤', '👥', '💬', '👣', '💭', '🐶', '🐺', '🐱', '🐭', '🐹', '🐰', '🐸', '🐯', '🐨', '🐻', '🐷', '🐽', '🐮', '🐗', '🐵', '🐒', '🐴', '🐑', '🐘', '🐼', '🐧', '🐦', '🐤', '🐥', '🐣', '🐔', '🐍', '🐢', '🐛', '🐝', '🐜', '🐞', '🐌', '🐙', '🐚', '🐠', '🐟', '🐬', '🐳', '🐋', '🐄', '🐏', '🐀', '🐃', '🐅', '🐇', '🐉', '🐎', '🐐', '🐓', '🐕', '🐖', '🐁', '🐂', '🐲', '🐡', '🐊', '🐫', '🐪', '🐆', '🐈', '🐩', '🐾', '💐', '🌸', '🌷', '🍀', '🌹', '🌻', '🌺', '🍁', '🍃', '🍂', '🌿', '🌾', '🍄', '🌵', '🌴', '🌲', '🌳', '🌰', '🌱', '🌼', '🌐', '🌞', '🌝', '🌚', '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌜', '🌛', '🌙', '🌍', '🌎', '🌏', '🌋', '🌌', '🌠', '⭐', '☀', '⛅', '☁', '⚡', '☔', '❄', '⛄', '🌀', '🌁', '🌈', '🌊', '🎍', '💝', '🎎', '🎒', '🎓', '🎏', '🎆', '🎇', '🎐', '🎑', '🎃', '👻', '🎅', '🎄', '🎁', '🎋', '🎉', '🎊', '🎈', '🎌', '🔮', '🎥', '📷', '📹', '📼', '💿', '📀', '💽', '💾', '💻', '📱', '☎', '📞', '📟', '📠', '📡', '📺', '📻', '🔊', '🔉', '🔈', '🔇', '🔔', '🔕', '📢', '📣', '⏳', '⌛', '⏰', '⌚', '🔓', '🔒', '🔏', '🔐', '🔑', '🔎', '💡', '🔦', '🔆', '🔅', '🔌', '🔋', '🔍', '🛁', '🛀', '🚿', '🚽', '🔧', '🔩', '🔨', '🚪', '🚬', '💣', '🔫', '🔪', '💊', '💉', '💰', '💴', '💵', '💷', '💶', '💳', '💸', '📲', '📧', '📥', '📤', '✉', '📩', '📨', '📯', '📫', '📪', '📬', '📭', '📮', '📦', '📝', '📄', '📃', '📑', '📊', '📈', '📉', '📜', '📋', '📅', '📆', '📇', '📁', '📂', '✂', '📌', '📎', '✒', '✏', '📏', '📐', '📕', '📗', '📘', '📙', '📓', '📔', '📒', '📚', '📖', '🔖', '📛', '🔬', '🔭', '📰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎵', '🎶', '🎹', '🎻', '🎺', '🎷', '🎸', '👾', '🎮', '🃏', '🎴', '🀄', '🎲', '🎯', '🏈', '🏀', '⚽', '⚾', '🎾', '🎱', '🏉', '🎳', '⛳', '🚵', '🚴', '🏁', '🏇', '🏆', '🎿', '🏂', '🏊', '🏄', '🎣', '☕', '🍵', '🍶', '🍼', '🍺', '🍻', '🍸', '🍹', '🍷', '🍴', '🍕', '🍔', '🍟', '🍗', '🍖', '🍝', '🍛', '🍤', '🍱', '🍣', '🍥', '🍙', '🍘', '🍚', '🍜', '🍲', '🍢', '🍡', '🍳', '🍞', '🍩', '🍮', '🍦', '🍨', '🍧', '🎂', '🍰', '🍪', '🍫', '🍬', '🍭', '🍯', '🍎', '🍏', '🍊', '🍋', '🍒', '🍇', '🍉', '🍓', '🍑', '🍈', '🍌', '🍐', '🍍', '🍠', '🍆', '🍅', '🌽', '🏠', '🏡', '🏫', '🏢', '🏣', '🏥', '🏦', '🏪', '🏩', '🏨', '💒', '⛪', '🏬', '🏤', '🌇', '🌆', '🏯', '🏰', '⛺', '🏭', '🗼', '🗾', '🗻', '🌄', '🌅', '🌃', '🗽', '🌉', '🎠', '🎡', '⛲', '🎢', '🚢', '⛵', '🚤', '🚣', '⚓', '🚀', '✈', '💺', '🚁', '🚂', '🚊', '🚉', '🚞', '🚆', '🚄', '🚅', '🚈', '🚇', '🚝', '🚋', '🚃', '🚎', '🚌', '🚍', '🚙', '🚘', '🚗', '🚕', '🚖', '🚛', '🚚', '🚨', '🚓', '🚔', '🚒', '🚑', '🚐', '🚲', '🚡', '🚟', '🚠', '🚜', '💈', '🚏', '🎫', '🚦', '🚥', '⚠', '🚧', '🔰', '⛽', '🏮', '🎰', '♨', '🗿', '🎪', '🎭', '📍', '🚩', '⬆', '⬇', '⬅', '➡', '🔠', '🔡', '🔤', '↗', '↖', '↘', '↙', '↔', '↕', '🔄', '◀', '▶', '🔼', '🔽', '↩', '↪', 'ℹ', '⏪', '⏩', '⏫', '⏬', '⤵', '⤴', '🆗', '🔀', '🔁', '🔂', '🆕', '🆙', '🆒', '🆓', '🆖', '📶', '🎦', '🈁', '🈯', '🈳', '🈵', '🈴', '🈲', '🉐', '🈹', '🈺', '🈶', '🈚', '🚻', '🚹', '🚺', '🚼', '🚾', '🚰', '🚮', '🅿', '♿', '🚭', '🈷', '🈸', '🈂', 'Ⓜ', '🛂', '🛄', '🛅', '🛃', '🉑', '㊙', '㊗', '🆑', '🆘', '🆔', '🚫', '🔞', '📵', '🚯', '🚱', '🚳', '🚷', '🚸', '⛔', '✳', '❇', '❎', '✅', '✴', '💟', '🆚', '📳', '📴', '🅰', '🅱', '🆎', '🅾', '💠', '➿', '♻', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '⛎', '🔯', '🏧', '💹', '💲', '💱', '©', '®', '™', '〽', '〰', '🔝', '🔚', '🔙', '🔛', '🔜', '❌', '⭕', '❗', '❓', '❕', '❔', '🔃', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '✖', '➕', '➖', '➗', '♠', '♥', '♣', '♦', '💮', '💯', '✔', '☑', '🔘', '🔗', '➰', '🔱', '🔲', '🔳', '◼', '◻', '◾', '◽', '▪', '▫', '🔺', '⬜', '⬛', '⚫', '⚪', '🔴', '🔵', '🔻', '🔶', '🔷', '🔸', '🔹'
          ];

          const emoji = emojiList[Math.floor(Math.random() * emojiList.length)];
          const replyPost = composeReplyPost(aaList[Math.floor(Math.random() * aaList.length)].replace("Z", emoji), ev);
          publishToRelay(relay, replyPost);
          publishToRelay(relay, composeReaction(emoji, ev));
        }

        if (ev.content.match(/(count|カウント)/gi)) {
          wFlag = true;
          console.log("発火(カウンタ): " + ev.content);

          if (userData.counter != undefined) {
            userData.counter++;
          } else {
            userData.counter = 1;
          }
          const replyPost = composeReplyPost(userData.counter + "回目です", ev);
          publishToRelay(relay, replyPost);
        }

        if (ev.content.match(/(loginbonus|ログインボーナス|ログボ|ろぐぼ)/gi)) {
          wFlag = true;
          console.log("発火(ログボ): " + ev.content);

          if (ev.created_at >= currUnixtime() + 10) {
            // 時間が10秒以上先
            const message = "未来からログインしないで！";
          } else {
            // 正常なイベント
            if (userData.loginBonus != undefined) {
              // 既存ユーザー
              const loginBonus = userData.loginBonus;
              const lastLoginTime = fromUnixTime(loginBonus.lastLoginTime);
              const currentDay = new Date(new Date().setHours(0, 0, 0, 0));
              const yesterDay = subDays(currentDay, 1);
              if (lastLoginTime < currentDay) {
                //ログボ発生
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

                const message = `こんにちは！\nあなたの合計ログイン回数は${loginBonus.totalLoginCount}回です。\nあなたの連続ログイン回数は${loginBonus.consecutiveLoginCount}回です。`;
                // メッセージ送信
                const replyPost = composeReplyPost(message, ev);
                publishToRelay(relay, replyPost);
              } else {
                //すでにログイン済
                console.log("すでにログイン済");
                const message = `今日はもうログイン済みです。\nあなたの合計ログイン回数は${loginBonus.totalLoginCount}回です。\nあなたの連続ログイン回数は${loginBonus.consecutiveLoginCount}回です。`;
                // メッセージ送信
                const replyPost = composeReplyPost(message, ev);
                publishToRelay(relay, replyPost);
              }
            } else {
              // 新規ユーザー
              console.log("新規ユーザー");
              const loginBonus = new Object();
              loginBonus.totalLoginCount = 1;
              loginBonus.consecutiveLoginCount = 1;
              loginBonus.lastLoginTime = ev.created_at;
              // ユーザーデータ保存
              userData.loginBonus = loginBonus;
              const message = "はじめまして！\n最初のログインです";
              // メッセージ送信
              const replyPost = composeReplyPost(message, ev);
              publishToRelay(relay, replyPost);
            }
          }
        }

        if (ev.content.match(/(unixtime)/gi)) {
          wFlag = true;
          console.log("発火(unixtime): " + ev.content);

          const replyPost = composeReplyPost("現在は" + currUnixtime() + "です。", ev);
          publishToRelay(relay, replyPost);
        };

        if (ev.content.match(/(blocktime)/gi)) {
          wFlag = true;
          console.log("発火(blocktime): " + ev.content);

          axios.get("https://mempool.space/api/blocks/tip/height").then(response => {
            const replyPost = composeReplyPost(`現在のblocktimeは${response.data}です。`, ev);
            publishToRelay(relay, replyPost);
          }).catch(error => {
            const replyPost = composeReplyPost(`取得に失敗しました…`, ev);
            publishToRelay(relay, replyPost);
          });
        }

        if (ev.content.match(/satconv\s(\d+)/gi)) {
          wFlag = true;
          console.log("発火(satconv): " + ev.content);

          const sat = Number(ev.content.match(/satconv\s(\d+)/i)[1]);
          if (systemData.currencyData.updateAt != undefined) {
            const usd = sat2btc(sat) * systemData.currencyData.btc2usd;
            const jpy = sat2btc(sat) * systemData.currencyData.btc2jpy;
            const updateAt = format(fromUnixTime(systemData.currencyData.updateAt), "yyyy-MM-dd kk:mm");
            const message = `丰${sat} = ￥${jpy} ＄${usd}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
            const replyPost = composeReplyPost(message, ev);
            publishToRelay(relay, replyPost);
          }
        };

        if (ev.content.match(/jpyconv\s(\d+)/gi)) {
          wFlag = true;
          console.log("発火(jpyconv): " + ev.content);

          const jpy = Number(ev.content.match(/jpyconv\s(\d+)/i)[1]);
          if (systemData.currencyData.updateAt != undefined) {
            const usd = jpy / systemData.currencyData.usd2jpy;
            const sat = btc2sat(jpy / systemData.currencyData.btc2jpy);
            const updateAt = format(fromUnixTime(systemData.currencyData.updateAt), "yyyy-MM-dd kk:mm");
            const message = `￥${jpy} = 丰${sat} ＄${usd}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
            const replyPost = composeReplyPost(message, ev);
            publishToRelay(relay, replyPost);
          }
        };

        if (ev.content.match(/usdconv\s(\d+)/gi)) {
          wFlag = true;
          console.log("発火(usdconv): " + ev.content);

          const usd = Number(ev.content.match(/usdconv\s(\d+)/i)[1]);
          if (systemData.currencyData.updateAt != undefined) {
            const jpy = usd * systemData.currencyData.usd2jpy;
            const sat = btc2sat(usd / systemData.currencyData.btc2usd);
            const updateAt = format(fromUnixTime(systemData.currencyData.updateAt), "yyyy-MM-dd kk:mm");
            const message = `＄${usd} = 丰${sat} ￥${jpy}\nupdate at: ${updateAt}\nPowered by CoinGecko`;
            const replyPost = composeReplyPost(message, ev);
            publishToRelay(relay, replyPost);
          }
        };

        if (ev.content.match(/(remind)\s(.*)/gi)) {
          wFlag = true;
          console.log("発火(リマインダ): " + ev.content);
          let message;
          const reminderList = systemData.reminderList || new Array();

          const reminderDateText = ev.content.match(/(remind)\s(.*)/i)[2];
          const reminderDate = chrono.parseDate(reminderDateText) || fromUnixTime(0);
          if (reminderDate > new Date()) {
            const record = {
              remindAt: reminderDate.getTime(),
              eventId: ev.id,
              eventPubkey: ev.pubkey,
            };
            reminderList.push(record);
            message = format(reminderDate, "yyyy-MM-dd kk:mm") + "になったらお知らせします！";
          } else {
            message = "正しく処理できませんでした…";
          }
          const replyPost = composeReplyPost(message, ev);
          publishToRelay(relay, replyPost);
          systemData.reminderList = reminderList;
        }

        if (ev.content.match(/(info|情報)/gi)) {
          wFlag = true;
          console.log("発火(情報): " + ev.content);
          if (userData.infoTimer === undefined)
            userData.infoTimer = 0;

          const timerDuration = currUnixtime() - userData.infoTimer;
          const COOLDOWN_TIMER = 10 * 60;
          if (timerDuration >= COOLDOWN_TIMER) {
            const metadata = strfryGetMetadata(ev.pubkey);
            console.log(metadata);
            let userName;
            let message;
            if (validateEvent(metadata) && verifySignature(metadata)) {
              const userInfo = JSON.parse(metadata.content);
              userName = userInfo.display_name || userInfo.displayName || undefined;
            }
            if (userName != undefined)
              message = `こんにちは！ ${userName}さん！\n`;
            else
              message = `こんにちは！ (まだkind:0を受信していません)\n`;

            message += "やぶみが把握しているあなたのイベントは以下の通りです。 (day, week, month, total)\n"

            const countNoteDay = strfryCount({ authors: [ev.pubkey], kinds: [1], since: getUnixTime(subDays(new Date(), 1)) });
            const countNoteWeek = strfryCount({ authors: [ev.pubkey], kinds: [1], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countNoteMonth = strfryCount({ authors: [ev.pubkey], kinds: [1], since: getUnixTime(subMonths(new Date(), 1)) });
            const countNoteTotal = strfryCount({ authors: [ev.pubkey], kinds: [1] });
            message += `投稿(kind: 1): ${countNoteDay}, ${countNoteWeek}, ${countNoteMonth}, ${countNoteTotal}\n`;

            const countRepostDay = strfryCount({ authors: [ev.pubkey], kinds: [6], since: getUnixTime(subDays(new Date(), 1)) });
            const countRepostWeek = strfryCount({ authors: [ev.pubkey], kinds: [6], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countRepostMonth = strfryCount({ authors: [ev.pubkey], kinds: [6], since: getUnixTime(subMonths(new Date(), 1)) });
            const countRepostTotal = strfryCount({ authors: [ev.pubkey], kinds: [6] });
            message += `リポスト(kind: 6): ${countRepostDay}, ${countRepostWeek}, ${countRepostMonth}, ${countRepostTotal}\n`;

            const countReactionDay = strfryCount({ authors: [ev.pubkey], kinds: [7], since: getUnixTime(subDays(new Date(), 1)) });
            const countReactionWeek = strfryCount({ authors: [ev.pubkey], kinds: [7], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countReactionMonth = strfryCount({ authors: [ev.pubkey], kinds: [7], since: getUnixTime(subMonths(new Date(), 1)) });
            const countReactionTotal = strfryCount({ authors: [ev.pubkey], kinds: [7] });
            message += `リアクション(kind: 7): ${countReactionDay}, ${countReactionWeek}, ${countReactionMonth}, ${countReactionTotal}\n`;

            const countEventDay = strfryCount({ authors: [ev.pubkey], since: getUnixTime(subDays(new Date(), 1)) });
            const countEventWeek = strfryCount({ authors: [ev.pubkey], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countEventMonth = strfryCount({ authors: [ev.pubkey], since: getUnixTime(subMonths(new Date(), 1)) });
            const countEventTotal = strfryCount({ authors: [ev.pubkey] });
            message += `全てのイベント: ${countEventDay}, ${countEventWeek}, ${countEventMonth}, ${countEventTotal}`;

            const replyPost = composeReplyPost(message, ev);
            publishToRelay(relay, replyPost);
            userData.infoTimer = currUnixtime();
          } else {
            const timerCooldown = COOLDOWN_TIMER - timerDuration;
            const replyPost = composeReplyPost("しばらく経ってからもう一度実行してください…\ncooldown: " + timerCooldown, ev);
            publishToRelay(relay, replyPost);
          }
        }

        if (ev.content.match(/(status|ステータス)/gi)) {
          wFlag = true;
          console.log("発火(ステータス): " + ev.content);
          if (systemData.statusTimer === undefined)
            systemData.statusTimer = 0;

          const timerDuration = currUnixtime() - systemData.statusTimer;

          const COOLDOWN_TIMER = 5 * 60;

          if (timerDuration >= COOLDOWN_TIMER) {
            // 前回から5分経っているので処理する
            let message = "やぶみが把握している全てのユーザーのイベントは以下の通りです。 (day, week, month, total)\n"

            const countMetadataDay = strfryCount({ kinds: [0], since: getUnixTime(subDays(new Date(), 1)) });
            const countMetadataWeek = strfryCount({ kinds: [0], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countMetadataMonth = strfryCount({ kinds: [0], since: getUnixTime(subMonths(new Date(), 1)) });
            const countMetadataTotal = strfryCount({ kinds: [0] });
            message += `メタデータ(kind: 0): ${countMetadataDay}, ${countMetadataWeek}, ${countMetadataMonth}, ${countMetadataTotal}\n`;

            const countNoteDay = strfryCount({ kinds: [1], since: getUnixTime(subDays(new Date(), 1)) });
            const countNoteWeek = strfryCount({ kinds: [1], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countNoteMonth = strfryCount({ kinds: [1], since: getUnixTime(subMonths(new Date(), 1)) });
            const countNoteTotal = strfryCount({ kinds: [1] });
            message += `投稿(kind: 1): ${countNoteDay}, ${countNoteWeek}, ${countNoteMonth}, ${countNoteTotal}\n`;

            const countRepostDay = strfryCount({ kinds: [6], since: getUnixTime(subDays(new Date(), 1)) });
            const countRepostWeek = strfryCount({ kinds: [6], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countRepostMonth = strfryCount({ kinds: [6], since: getUnixTime(subMonths(new Date(), 1)) });
            const countRepostTotal = strfryCount({ kinds: [6] });
            message += `リポスト(kind: 6): ${countRepostDay}, ${countRepostWeek}, ${countRepostMonth}, ${countRepostTotal}\n`;

            const countReactionDay = strfryCount({ kinds: [7], since: getUnixTime(subDays(new Date(), 1)) });
            const countReactionWeek = strfryCount({ kinds: [7], since: getUnixTime(subWeeks(new Date(), 1)) });
            const countReactionMonth = strfryCount({ kinds: [7], since: getUnixTime(subMonths(new Date(), 1)) });
            const countReactionTotal = strfryCount({ kinds: [7] });
            message += `リアクション(kind: 7): ${countReactionDay}, ${countReactionWeek}, ${countReactionMonth}, ${countReactionTotal}\n`;

            const countEventDay = strfryCount({ since: getUnixTime(subDays(new Date(), 1)) });
            const countEventWeek = strfryCount({ since: getUnixTime(subWeeks(new Date(), 1)) });
            const countEventMonth = strfryCount({ since: getUnixTime(subMonths(new Date(), 1)) });
            const countEventTotal = strfryCount({});
            message += `全てのイベント: ${countEventDay}, ${countEventWeek}, ${countEventMonth}, ${countEventTotal}`;
            const replyPost = composeReplyPost(message, ev);
            publishToRelay(relay, replyPost);
            systemData.statusTimer = currUnixtime();
          } else {
            const timerCooldown = COOLDOWN_TIMER - timerDuration;
            const replyPost = composeReplyPost("しばらく経ってからもう一度実行してください…\nCooldown: " + timerCooldown, ev);
            publishToRelay(relay, replyPost);
          }
        }

        if (ev.content.match(/(reboot|再起動)/gi)) {
          wFlag = true;
          console.log("発火(再起動): " + ev.content);
          if (ev.pubkey === ADMIN_HEX) {
            const replyPost = composeReplyPost("💤", ev);
            publishToRelay(relay, replyPost);
            process.exit(0);
          } else {
            const replyPost = composeReplyPost("誰？", ev);
            publishToRelay(relay, replyPost);
          }
        }

        if (ev.content.match(/(help|ヘルプ)/gi)) {
          wFlag = true;
          console.log("発火(ヘルプ): " + ev.content);
          let message = "";
          message += "こんにちは！やぶみちゃんです！\n";
          message += "現在は出来ることは以下の通りです！\n";
          message += "(blocktime) : 現在のブロックタイムを表示します！\n";
          message += "(count|カウント) : カウントを呼び出した回数を表示します！\n";
          message += "(dice) [ダイスの数と面の数] : さいころを振ります！\n";
          message += "(fav|ふぁぼ|ファボ|祝福|星) : リアクションを送信します！\n";
          message += "(help|ヘルプ) : このメッセージを表示します！\n";
          message += "(info|情報) : あなたの統計情報をやぶみリレーから確認します！\n";
          message += "(loginbonus|ログインボーナス|ログボ|ろぐぼ) : ログインボーナスです！\n";
          message += "(ping) : pong!と返信します！\n";
          message += "(remind) <希望時間> : 希望時間にリプライを送信します！\n";
          message += "(satconv|usdconv|jpyconv) <金額> : 通貨変換をします！(Powered by CoinGecko)\n";
          message += "(status|ステータス) : やぶみリレーの統計情報を表示します！\n";
          message += "(unixtime) : 現在のUnixTimeを表示します！\n";

          const replyPost = composeReplyPost(message, ev);
          publishToRelay(relay, replyPost);
        }

        if (!wFlag) {
          console.log("発火(知らない): " + ev.content);
          if (userData.failedTimer === undefined)
            userData.failedTimer = 0;

          if (currUnixtime() - userData.failedTimer >= 60 * 5) {
            // 前回から5分経っているので処理する
            const replyPost = composeReplyPost("知らない", ev);
            publishToRelay(relay, replyPost);
          }

          userData.failedTimer = currUnixtime();
        }
        memoryData.set(ev.pubkey, userData);
        memoryData.set("_", systemData);
      }
    } catch (err) {
      console.error(err);
    }
  });
};

main().catch((e) => console.error(e));