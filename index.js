// ====== Core ======
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");

// ====== App ======
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(helmet({ crossOriginResourcePolicy: false }));

// ====== Config ======
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://MyGameServer:fwu9A09aQU2VsPhD@cluster1.do09hor.mongodb.net/?retryWrites=true&w=majority&appName=Cluster1";

const OWNER_ID = process.env.OWNER_ID || "owner_temp";
const MIN_BET = 10;
const MIN_GIFT_AMOUNT = 10;

// ====== DB Connect ======
mongoose
  .connect(MONGODB_URI, { dbName: "sunova" })
  .then(() => console.log("✅ Connected to MongoDB Atlas"))
  .catch((err) => {
    console.error("❌ DB Connection Error:", err);
  });

// ====== Schemas & Models (بدون تغيير) ======
const UserSchema = new mongoose.Schema(
  {
    userId: { type: String, unique: true, index: true },
    balance: { type: Number, default: 0 },
    diamonds: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const TransactionSchema = new mongoose.Schema(
  {
    userId: String,
    type: String,
    amount: Number,
    game: String,
    meta: Object,
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const WinnerSchema = new mongoose.Schema(
  {
    roundId: String,
    name: String,
    userId: String,
    prize: Number,
    label: String,
    game: String,
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const DailyScoreSchema = new mongoose.Schema(
  {
    day: { type: String, index: true },
    userId: { type: String, index: true },
    score: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const BetSchema = new mongoose.Schema(
  {
    roundId: String,
    userId: String,
    optionId: String,
    amount: Number,
    game: { type: String, default: "roulette" },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const RocketStateSchema = new mongoose.Schema(
  {
    _id: String,
    isRunning: { type: Boolean, default: false },
    multiplier: { type: Number, default: 1.0 },
    players: {
      type: Map,
      of: {
        bet: Number,
        cashedOut: Boolean,
        winnings: { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);
const Transaction = mongoose.model("Transaction", TransactionSchema);
const Winner = mongoose.model("Winner", WinnerSchema);
const DailyScore = mongoose.model("DailyScore", DailyScoreSchema);
const Bet = mongoose.model("Bet", BetSchema);
const RocketState = mongoose.model("RocketState", RocketStateSchema);

// ====== Helpers ======
const todayKey = () => new Date().toISOString().slice(0, 10);

async function ensureUser(userId) {
  let u = await User.findOne({ userId });
  if (!u) u = await User.create({ userId, balance: 0, diamonds: 0 });
  return u;
}
async function ensureOwner() {
  return ensureUser(OWNER_ID);
}
async function addDaily(userId, delta) {
  const key = todayKey();
  await DailyScore.updateOne(
    { day: key, userId },
    { $inc: { score: delta } },
    { upsert: true }
  );
}
async function addTx({ userId, type, amount, game, meta }) {
  await Transaction.create({ userId, type, amount, game, meta });
}
function randBetween(min, max) {
  return Math.random() * (max - min) + min;
}

const isEven = (n) => n > 0 && n % 2 === 0;
const isOdd = (n) => n > 0 && n % 2 !== 0;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACK = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

const PAYOUTS = {
  "0": 35,
  "1_12": 3,
  "13_25": 3,
  "26_36": 3,
  even: 2,
  odd: 2,
  red: 2,
  black: 2,
};

// ====== Daily reset (UTC midnight) ======
app.get("/api/cron/daily-reset", async (req, res) => {
  const k = todayKey();
  try {
    await DailyScore.deleteMany({ day: { $ne: k } });
    console.log("🔄 Daily leaderboard reset triggered by Vercel Cron");
    res.json({ ok: true, message: "Daily reset completed" });
  } catch (e) {
    console.error("Daily reset error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== Health & Status ======
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Sunova Games API", base: "Vercel" });
});
app.get("/ping", (_req, res) => res.send("OK ✅"));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/status", async (_req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const dbState = states[mongoose.connection.readyState] || "unknown";
  res.json({
    ok: true,
    service: "Sunova Games API",
    base: "Vercel",
    time: new Date().toISOString(),
    db: dbState,
    uptimeSec: process.uptime()
  });
});

// ====== Users (عرض وتحديث الرصيد من تطبيق خارجي) ======
app.post("/api/register", async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId مطلوب" });
    const u = await ensureUser(userId);
    res.json({ ok: true, userId: u.userId, balance: u.balance, diamonds: u.diamonds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/balance/:userId", async (req, res) => {
  try {
    const u = await ensureUser(req.params.userId);
    res.json({ balance: u.balance, diamonds: u.diamonds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/user/:userId/refresh", async (req, res) => {
  try {
    const u = await ensureUser(req.params.userId);
    const day = todayKey();
    const ds =
      (await DailyScore.findOne({ day, userId: u.userId })) || { score: 0 };
    res.json({ userId: u.userId, balance: u.balance, diamonds: u.diamonds, day, dailyScore: ds.score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/user/:userId", async (req, res) => {
  try {
    const u = await ensureUser(req.params.userId);
    const day = todayKey();
    const ds =
      (await DailyScore.findOne({ day, userId: u.userId })) || { score: 0 };
    res.json({ userId: u.userId, balance: u.balance, diamonds: u.diamonds, day, dailyScore: ds.score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/user/update", async (req, res) => {
  try {
    const { userId, amount, reason } = req.body || {};
    if (!userId || typeof amount !== "number")
      return res.status(400).json({ error: "userId و amount مطلوبان" });

    const u = await ensureUser(userId);
    const newBalance = u.balance + amount;
    if (newBalance < 0) {
      return res.status(400).json({ error: "الرصيد غير كافي للخصم المطلوب", balance: u.balance });
    }

    u.balance = newBalance;
    await u.save();

    await addTx({
      userId,
      type: "adjust",
      amount,
      game: "wallet",
      meta: { reason: reason || "external_update" },
    });
    await addDaily(userId, amount);

    res.json({ ok: true, userId, balance: u.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/topup", async (req, res) => {
  try {
    const { userId, amount, ref } = req.body || {};
    if (!userId || !amount || amount <= 0)
      return res.status(400).json({ error: "بيانات الشحن غير صحيحة" });
    const u = await ensureUser(userId);
    u.balance += amount;
    await u.save();
    await addTx({
      userId,
      type: "topup",
      amount,
      game: "wallet",
      meta: { ref },
    });
    await addDaily(userId, amount);
    res.json({ ok: true, balance: u.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== NEW: مسار إرسال الهدايا (Coins) إلى (Diamonds) ======
app.post("/api/gift", async (req, res) => {
  try {
    const { senderId, receiverId, amount } = req.body || {};
    if (!senderId || !receiverId || !amount || amount < MIN_GIFT_AMOUNT) {
      return res.status(400).json({ error: "بيانات الهدية غير صحيحة" });
    }
    
    // المستخدم لا يمكن أن يهدي نفسه
    if (senderId === receiverId) {
      return res.status(400).json({ error: "لا يمكن إهداء نفسك" });
    }

    const sender = await ensureUser(senderId);
    const receiver = await ensureUser(receiverId);

    if (sender.balance < amount) {
      return res.status(400).json({ error: "الرصيد غير كافٍ لإرسال الهدية" });
    }

    // 1. خصم المبلغ بالكامل من رصيد الكوينزات الخاص بالمرسل
    sender.balance -= amount;
    await sender.save();
    await addTx({
      userId: senderId,
      type: "gift_sent",
      amount: -amount,
      game: "wallet",
      meta: { to: receiverId },
    });
    await addDaily(senderId, -amount);

    // 2. إضافة نفس المبلغ بالكامل إلى رصيد الماس الخاص بالمستلم
    receiver.diamonds += amount;
    await receiver.save();
    await addTx({
      userId: receiverId,
      type: "gift_received",
      amount: amount,
      game: "wallet",
      meta: { from: senderId },
    });
    
    // 3. لا يوجد تغيير في رصيد البيت (لا عمولة)

    res.json({
      ok: true,
      senderBalance: sender.balance,
      receiverDiamonds: receiver.diamonds,
      message: `تم إهداء ${amount} بنجاح. المرسل حصل على ${amount} ماسة.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Leaderboards & Winners ======
app.get("/api/daily-top", async (_req, res) => {
  try {
    const day = todayKey();
    const list = await DailyScore.find({ day })
      .sort({ score: -1 })
      .limit(20)
      .lean();
    const mapped = list.map((x) => ({ name: x.userId, score: x.score }));
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/top-winners", async (_req, res) => {
  try {
    const w = await Winner.find().sort({ createdAt: -1 }).limit(10).lean();
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/winners/:roundId", async (req, res) => {
  try {
    const w = await Winner.find({ roundId: req.params.roundId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/winners", async (_req, res) => {
  try {
    const w = await Winner.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Roulette (متوافق مع الواجهة) ====== 

app.post("/api/place-bet", async (req, res) => {
  try {
    const { userId, roundId, optionId, amount } = req.body || {};
    if (!userId || !roundId || !optionId || !amount)
      return res.status(400).json({ error: "بيانات ناقصة" });
    if (amount < MIN_BET)
      return res.status(400).json({ error: `أقل رهان ${MIN_BET}` });

    const u = await ensureUser(userId);
    if (u.balance < amount) return res.status(400).json({ error: "رصيد غير كافي" });

    u.balance -= amount;
    await u.save();
    await addTx({
      userId,
      type: "bet",
      amount,
      game: "roulette",
      meta: { roundId, optionId },
    });
    await addDaily(userId, -amount);

    const owner = await ensureOwner();
    owner.balance += amount;
    await owner.save();
    await addTx({
      userId: OWNER_ID,
      type: "house_credit",
      amount,
      game: "roulette",
      meta: { from: userId, roundId },
    });

    await Bet.create({ roundId, userId, optionId, amount, game: "roulette" });

    res.json({ balance: u.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settle", async (req, res) => {
  try {
    const { roundId, result } = req.body || {};
    if (!roundId || typeof result !== "number") {
      return res.status(400).json({ error: "Round ID والنتيجة مطلوبة" });
    }

    const betsInRound = await Bet.find({ roundId, game: "roulette" });
    if (betsInRound.length === 0) {
      return res.status(404).json({ error: "لم يتم العثور على رهانات لهذه الجولة" });
    }

    let totalPayouts = 0;

    for (const bet of betsInRound) {
      let win = false;
      if (bet.optionId === "0" && result === 0) win = true;
      else if (bet.optionId === "1_12" && result >= 1 && result <= 12) win = true;
      else if (bet.optionId === "13_25" && result >= 13 && result <= 25) win = true;
      else if (bet.optionId === "26_36" && result >= 26 && result <= 36) win = true;
      else if (bet.optionId === "even" && isEven(result)) win = true;
      else if (bet.optionId === "odd" && isOdd(result)) win = true;
      else if (bet.optionId === "red" && RED.has(result)) win = true;
      else if (bet.optionId === "black" && BLACK.has(result)) win = true;

      if (win) {
        const p = PAYOUTS[bet.optionId] || 0;
        const prize = Math.floor(bet.amount * p);
        totalPayouts += prize;
        
        const user = await ensureUser(bet.userId);
        user.balance += prize;
        await user.save();

        await addTx({
          userId: bet.userId,
          type: "win",
          amount: prize,
          game: "roulette",
          meta: { roundId, result },
        });
        await addDaily(bet.userId, prize);

        await Winner.create({
          roundId,
          name: bet.userId,
          userId,
          prize,
          label: `Roulette ${result}`,
          game: "roulette",
        });
      }
    }

    res.json({
      ok: true,
      roundId,
      result,
      totalPayouts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== ألعاب Play-once ======
async function playSimpleGame({
  userId,
  game,
  betAmount,
  winChance,
  minMult,
  maxMult,
  labelBuilder,
}) {
  if (!userId || !betAmount) throw new Error("بيانات ناقصة");
  if (betAmount < MIN_BET) throw new Error(`أقل رهان ${MIN_BET}`);

  const u = await ensureUser(userId);
  if (u.balance < betAmount) throw new Error("رصيد غير كافي");

  u.balance -= betAmount;
  await u.save();
    await addTx({ userId, type: "bet", amount: betAmount, game });
    await addDaily(userId, -betAmount);

  const owner = await ensureOwner();
  owner.balance += betAmount;
  await owner.save();
  await addTx({
    userId: OWNER_ID,
    type: "house_credit",
    amount: betAmount,
    game,
    meta: { from: userId },
  });

  const win = Math.random() < winChance;
  if (win) {
    const mult = +randBetween(minMult, maxMult).toFixed(2);
    const prize = Math.floor(betAmount * mult);

    u.balance += prize;
    await u.save();
    await addTx({ userId, type: "win", amount: prize, game, meta: { mult } });
    await addDaily(userId, prize);

    await Winner.create({
      roundId: `${game}-${Date.now()}`,
      name: userId,
      userId,
      prize,
      label: labelBuilder ? labelBuilder(mult, prize) : `${game} x${mult}`,
      game,
    });

    return {
      status: "win",
      multiplier: mult,
      winnings: prize,
      balance: u.balance,
      diamonds: u.diamonds,
    };
  } else {
    await addTx({ userId, type: "loss", amount: betAmount, game });
    return { status: "loss", lost: betAmount, balance: u.balance, diamonds: u.diamonds };
  }
}

// القط الجشع
app.post("/api/greedy-cat/play", async (req, res) => {
  try {
    const { userId, betAmount } = req.body || {};
    const r = await playSimpleGame({
      userId,
      betAmount,
      game: "greedy_cat",
      winChance: 0.45,
      minMult: 1.2,
      maxMult: 3.5,
      labelBuilder: (m, p) => `Greedy Cat x${m} (+${p})`,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ملاكمة الأسد والنمر
app.post("/api/lion-tiger/play", async (req, res) => {
  try {
    const { userId, betAmount } = req.body || {};
    const r = await playSimpleGame({
      userId,
      betAmount,
      game: "lion_tiger",
      winChance: 0.48,
      minMult: 1.1,
      maxMult: 2.8,
      labelBuilder: (m, p) => `Lion vs Tiger x${m} (+${p})`,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// السمكة
app.post("/api/fish/play", async (req, res) => {
  try {
    const { userId, betAmount } = req.body || {};
    const r = await playSimpleGame({
      userId,
      betAmount,
      game: "fish",
      winChance: 0.42,
      minMult: 1.3,
      maxMult: 4.2,
      labelBuilder: (m, p) => `Fish x${m} (+${p})`,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// الجاك بوت
app.post("/api/jackpot/play", async (req, res) => {
  try {
    const { userId, betAmount } = req.body || {};
    const r = await playSimpleGame({
      userId,
      betAmount,
      game: "jackpot",
      winChance: 0.15,
      minMult: 3,
      maxMult: 15,
      labelBuilder: (m, p) => `Jackpot x${m} (+${p})`,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ====== Rocket (multiplayer بسيط) ======
app.get("/api/rocket/state", async (req, res) => {
  try {
    const state = await RocketState.findById("rocket_state");
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rocket/join", async (req, res) => {
  try {
    const { userId, bet } = req.body || {};
    if (!userId || !bet) return res.status(400).json({ error: "بيانات ناقصة" });
    if (bet < MIN_BET) return res.status(400).json({ error: `أقل رهان ${MIN_BET}` });
    
    const state = await RocketState.findById("rocket_state");
    if (state && state.isRunning) {
      return res.status(400).json({ error: "اللعبة جارية بالفعل" });
    }

    const u = await ensureUser(userId);
    if (u.balance < bet) return res.status(400).json({ error: "رصيد غير كافي" });

    u.balance -= bet;
    await u.save();
    await addTx({ userId, type: "bet", amount: bet, game: "rocket" });
    await addDaily(userId, -bet);

    const owner = await ensureOwner();
    owner.balance += bet;
    await owner.save();
    await addTx({
      userId: OWNER_ID,
      type: "house_credit",
      amount: bet,
      game: "rocket",
      meta: { from: userId },
    });

    await RocketState.updateOne(
      { _id: "rocket_state" },
      {
        $set: { [`players.${userId}`]: { bet, cashedOut: false } },
        $setOnInsert: { isRunning: false, multiplier: 1.0 },
      },
      { upsert: true }
    );

    res.json({ success: true, balance: u.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/rocket/cashout", async (req, res) => {
  try {
    const { userId } = req.body || {};
    const state = await RocketState.findById("rocket_state").lean();
    
    if (!state || !state.players[userId]) {
      return res.status(400).json({ error: "ليس داخل اللعبة" });
    }
    const player = state.players[userId];
    
    if (player.cashedOut) {
      return res.status(400).json({ error: "تم السحب بالفعل" });
    }

    const winnings = Math.floor(player.bet * state.multiplier);
    const u = await ensureUser(userId);

    u.balance += winnings;
    await u.save();
    await addTx({
      userId,
      type: "win",
      amount: winnings,
      game: "rocket",
      meta: { mult: state.multiplier },
    });
    await addDaily(userId, winnings);

    await RocketState.updateOne(
      { _id: "rocket_state" },
      { $set: { 
          [`players.${userId}.cashedOut`]: true,
          [`players.${userId}.winnings`]: winnings,
      } }
    );

    await Winner.create({
      roundId: `rocket-${Date.now()}`,
      name: userId,
      userId,
      prize: winnings,
      label: `Rocket x${state.multiplier}`,
      game: "rocket",
    });

    res.json({ success: true, winnings, balance: u.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/rocket/update-multiplier", async (req, res) => {
  try {
    const { newMultiplier } = req.body || {};
    if (!newMultiplier) {
      return res.status(400).json({ error: "الـ multiplier مطلوب" });
    }
    await RocketState.updateOne(
      { _id: "rocket_state" },
      { $set: { multiplier: newMultiplier, isRunning: true } },
      { upsert: true }
    );
    res.json({ success: true, newMultiplier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rocket/settle", async (_req, res) => {
  try {
    await RocketState.updateOne(
      { _id: "rocket_state" },
      { $set: { isRunning: false, multiplier: 1.0, players: {} } },
      { upsert: true }
    );
    
    res.json({ success: true, message: "Game state reset" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Transactions ======
app.get("/api/transactions/:userId", async (req, res) => {
  try {
    const list = await Transaction.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Export App for Vercel ======
module.exports = app;