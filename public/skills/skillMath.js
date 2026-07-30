// skillMath.js — pure functions, shared server-side and browser
import skillCurve from './skillCurve.json' with { type: 'json' };

export function calcSkillLv(xp) {
  const { xpDivisor, exponent, levelDivisor, minLevel } = skillCurve;
  return Math.max(minLevel, Math.floor(Math.pow(xp / xpDivisor, exponent) / levelDivisor));
}

export function calcXpForLevel(level) {
  const { xpDivisor, exponent, levelDivisor } = skillCurve;
  return Math.pow(level * levelDivisor, 1 / exponent) * xpDivisor;
}

export function calcXpForNextLevel(level) {
  return calcXpForLevel(level + 1);
}
