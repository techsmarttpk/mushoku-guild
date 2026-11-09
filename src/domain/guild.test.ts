import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVITIES,
  BODY,
  GUILD_SPOTS,
  OBSTACLES,
  SCENE,
  bodyBox,
  canChat,
  capabilityLabels,
  hashString,
  lookFor,
  lookSignature,
  memberState,
  overlaps,
  pickSeed,
  placeMembers,
  seedSignature,
  type Capabilities,
  type GuildMember,
} from "./guild.ts";

const caps: Capabilities = { textInput: true, textOutput: true, imageInput: false, imageOutput: false, tools: false, structuredOutput: false, streaming: true };
const member = (o: Partial<GuildMember> = {}): GuildMember => ({
  id: 1, provider: "openrouter", modelId: "v/m:free", name: "M", vendor: "v", seed: 1, status: "available", reason: "", contextLength: 8192, description: "", caps, recruitedAt: 1, connected: true, ...o,
});

test("a character look is a pure function of its seed, so it survives restarts", () => {
  for (const s of [0, 1, 42, 4_000_000_000]) assert.deepEqual(lookFor(s), lookFor(s));
  assert.notDeepEqual(lookFor(1), lookFor(2));
  assert.ok(ACTIVITIES.includes(lookFor(7).activity));
});

test("recruits never look alike: the seed advances until its look is unused", () => {
  const taken = new Set<string>();
  const seeds: number[] = [];
  for (let i = 0; i < 60; i++) {
    const seed = pickSeed(`vendor/model-${i}:free`, taken);
    const sig = seedSignature(seed);
    assert.ok(!taken.has(sig), `model ${i} duplicated a look`);
    taken.add(sig);
    seeds.push(seed);
  }
  assert.equal(new Set(seeds.map(seedSignature)).size, 60);
  // the same model on an empty roster always gets the same character
  assert.equal(pickSeed("a/b:free", new Set()), pickSeed("a/b:free", new Set()));
  // when its natural look is taken it is moved to another
  const natural = pickSeed("a/b:free", new Set());
  const moved = pickSeed("a/b:free", new Set([seedSignature(natural)]));
  assert.notEqual(seedSignature(moved), seedSignature(natural));
});

test("looks vary in clothing, hair, colour and accessories", () => {
  const looks = Array.from({ length: 200 }, (_, i) => lookFor(hashString(`m${i}`)));
  for (const key of ["skin", "hairStyle", "hair", "outfit", "cloth", "accessory"] as const) assert.ok(new Set(looks.map((l) => l[key])).size >= 4, key);
  assert.ok(new Set(looks.map((l) => l.activity)).size >= 5);
  assert.ok(new Set(looks.map(lookSignature)).size > 190);
});

test("every idle spot is inside the café, clear of furniture and of the other spots", () => {
  assert.ok(GUILD_SPOTS.length >= 10);
  for (const [i, s] of GUILD_SPOTS.entries()) {
    const b = bodyBox(s);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= SCENE.w && b.y + b.h <= SCENE.h, `spot ${i} leaves the scene`);
    for (const o of OBSTACLES) assert.ok(!overlaps(b, o), `spot ${i} stands on furniture at ${JSON.stringify(o)}`);
    for (const [j, t] of GUILD_SPOTS.entries()) if (j > i) assert.ok(!overlaps({ ...bodyBox(s), w: BODY.w + 2 }, bodyBox(t)), `spots ${i} and ${j} overlap`);
  }
});

test("placement gives each member their own spot and never moves earlier members", () => {
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, seed: hashString(`m${i}`) }));
  const full = placeMembers(roster);
  assert.equal(full.overflow, 0);
  assert.equal(new Set(full.placed.map((p) => `${p.spot.x},${p.spot.y}`)).size, 8);
  for (let n = 1; n < roster.length; n++) {
    const before = placeMembers(roster.slice(0, n)).placed;
    const after = placeMembers(roster.slice(0, n + 1)).placed;
    for (const p of before) assert.deepEqual(after.find((q) => q.id === p.id)?.spot, p.spot, `member ${p.id} moved when member ${n + 1} arrived`);
  }
  const boxes = full.placed.map((p) => bodyBox(p.spot));
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) assert.ok(!overlaps(a, b));
});

test("when the roster outgrows the café the extras are counted instead of crowding the room", () => {
  const roster = Array.from({ length: GUILD_SPOTS.length + 5 }, (_, i) => ({ id: i + 1, seed: i * 7 }));
  const { placed, overflow } = placeMembers(roster);
  assert.equal(placed.length, GUILD_SPOTS.length);
  assert.equal(overflow, 5);
  assert.deepEqual(placeMembers([]), { placed: [], overflow: 0 });
});

test("removing a member frees their spot for the next recruit", () => {
  const roster = [1, 2, 3].map((id) => ({ id, seed: id }));
  const all = placeMembers(roster).placed;
  const freed = all.find((p) => p.id === 2)?.spot;
  assert.ok(freed);
  const without = placeMembers(roster.filter((m) => m.id !== 2)).placed;
  assert.deepEqual(without.map((p) => p.id), [1, 3]);
  assert.deepEqual(without.find((p) => p.id === 1)?.spot, all.find((p) => p.id === 1)?.spot);
  // a newcomer whose preferred spot is the freed one stands there
  const idx = GUILD_SPOTS.findIndex((s) => s.x === freed.x && s.y === freed.y);
  const again = placeMembers([...roster.filter((m) => m.id !== 2), { id: 9, seed: idx }]).placed.find((p) => p.id === 9);
  assert.deepEqual(again?.spot, freed);
});

test("availability shows unavailable before offline, and chat needs both text and availability", () => {
  assert.equal(memberState(member()), "available");
  assert.equal(memberState(member({ connected: false })), "offline");
  assert.equal(memberState(member({ status: "unavailable", connected: false })), "unavailable");
  assert.ok(canChat(member()));
  assert.ok(!canChat(member({ status: "unavailable" })));
  assert.ok(!canChat(member({ connected: false })));
  assert.ok(!canChat(member({ caps: { ...caps, textOutput: false, imageOutput: true } })), "an image-only model cannot be chatted with");
});

test("capabilities are only listed when the metadata reported them", () => {
  assert.deepEqual(capabilityLabels(caps), ["Text", "Streaming"]);
  assert.deepEqual(capabilityLabels({ ...caps, imageInput: true, tools: true, structuredOutput: true }), ["Text", "Image input", "Tool calling", "Structured output", "Streaming"]);
  assert.deepEqual(capabilityLabels({ ...caps, textOutput: false, imageOutput: true, streaming: false }), ["Image generation"]);
});
