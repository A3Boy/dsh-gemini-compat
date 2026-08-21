// full_round_test.js
export function analyzeData(items) {
  const total = items.reduce((acc, curr) => acc + curr.score, 0);
  const average = total / items.length;
  return { count: items.length, total, average };
}

const dataset = [
  { id: "A01", name: "Alpha", score: 88 },
  { id: "A02", name: "Beta", score: 92 },
  { id: "A03", name: "Gamma", score: 79 },
  { id: "A04", name: "Delta", score: 95 }
];

console.log(JSON.stringify({ status: "ok", result: analyzeData(dataset) }));
