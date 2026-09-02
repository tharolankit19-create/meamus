'use strict';

/**
 * What a chat turn is asking for.
 *
 * The workspace chat used to have exactly one behaviour: rebuild the game.
 * That made two ordinary things impossible - asking a question about your own
 * game, and being told that a request is too vague to act on. Both were
 * answered with a full rebuild, which spent credits and produced a game the
 * player did not ask for.
 *
 * This classifier runs before the model, so a question costs nothing and a
 * vague instruction is met with a question rather than a guess.
 */

/** Words that make a turn a request to change the game. */
const CHANGE_VERBS = [
  'add', 'remove', 'delete', 'make', 'change', 'set', 'increase', 'decrease',
  'reduce', 'raise', 'lower', 'replace', 'swap', 'rename', 'move', 'speed',
  'slow', 'harder', 'easier', 'faster', 'slower', 'bigger', 'smaller', 'more',
  'fewer', 'less', 'give', 'put', 'turn', 'use', 'fix', 'tweak', 'adjust',
  'redesign', 'rebuild', 'colour', 'color', 'recolour', 'recolor'
];

/**
 * Openers that make a turn a question outright. "why is my ship so slow?"
 * contains the word "slow", but nobody typing it wants the ship changed.
 */
const STRONG_QUESTION = ['what', 'why', 'how', 'when', 'where', 'which', 'who', 'explain', 'tell'];

/**
 * Openers that are a question only when nothing is being asked for. "can you
 * add a shield?" is an order wearing a question mark.
 */
const MODAL_QUESTION = [
  'is', 'are', 'was', 'were', 'does', 'do', 'did',
  'can', 'could', 'should', 'would', 'will'
];

const QUESTION_OPENERS = STRONG_QUESTION.concat(MODAL_QUESTION);

/**
 * A turn this short and this unspecific cannot be built from. "make it better"
 * names no mechanic, no number and no visual - guessing produces a random
 * rewrite the player then has to undo.
 */
const VAGUE = [
  'better', 'nicer', 'cooler', 'good', 'great', 'improve', 'improved',
  'awesome', 'amazing', 'fun', 'nice', 'best', 'perfect', 'polish'
];

const words = (text) => String(text).toLowerCase().match(/[a-z']+/g) || [];

/**
 * @param {string} text the player's chat turn
 * @returns {{kind:'question'|'clarify'|'change', reason:string}}
 */
function classify(text) {
  const raw = String(text || '').trim();
  const w = words(raw);
  if (!w.length) return { kind: 'clarify', reason: 'empty' };

  const hasChangeVerb = w.some((x) => CHANGE_VERBS.includes(x));
  const endsWithQuestionMark = raw.endsWith('?');

  if (STRONG_QUESTION.includes(w[0])) {
    return { kind: 'question', reason: 'question-opener' };
  }
  // An order dressed as a question - "can you add a boss?" - is still an order.
  if ((MODAL_QUESTION.includes(w[0]) || endsWithQuestionMark) && !hasChangeVerb) {
    return { kind: 'question', reason: endsWithQuestionMark ? 'question-mark' : 'question-opener' };
  }

  // Vague only when what is left after the verbs is nothing but a value
  // judgement. "make it harder" names a direction; "make it better" does not.
  const meaningful = w.filter((x) => x.length > 2 && x !== 'the' && x !== 'and' && x !== 'it');
  const nonVerb = meaningful.filter((x) => !CHANGE_VERBS.includes(x));
  const hasVague = meaningful.some((x) => VAGUE.includes(x));
  if (w.length <= 6 && hasVague && nonVerb.length > 0 && nonVerb.every((x) => VAGUE.includes(x))) {
    return { kind: 'clarify', reason: 'no-specifics' };
  }

  return { kind: 'change', reason: hasChangeVerb ? 'change-verb' : 'default' };
}

/**
 * The question to put back when a turn is too vague to build from. Concrete
 * options beat "can you be more specific?", which just moves the problem.
 */
function clarifyingQuestion(spec) {
  const title = (spec && spec.gameConfig && spec.gameConfig.title) || 'this game';
  return `I can change ${title}, but "better" could mean several different things and ` +
    'guessing would spend a build on something you did not ask for. Which of these did you mean?\n\n' +
    '• Difficulty — faster enemies, tighter timing, fewer lives\n' +
    '• Feel — bigger hit effects, screen shake, punchier sound\n' +
    '• Looks — a different palette, larger sprites, a new background\n' +
    '• Content — a new enemy, a boss, an extra power-up\n\n' +
    'Tell me which one and I will build it.';
}

module.exports = { classify, clarifyingQuestion, CHANGE_VERBS, QUESTION_OPENERS, STRONG_QUESTION, MODAL_QUESTION, VAGUE };
