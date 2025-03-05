//mostly based off pf2e-thaum-vuln / PF2e Exploit Vulnerability from https://github.com/mysurvive/pf2e-thaum-vuln

const ACTUALIZE_VULNERABILITY_STANDARD_DC_UUID =
	"Compendium.actualizer.actualizer-effects.Item.TAJPxDbnq1rzgGEd";
const ACTUALIZE_VULNERABILITY_EASY_DC_UUID =
	"Compendium.actualizer.actualizer-effects.Item.wRgZD1aXCmy8Dvh4";
	
const SupportedActions = [
	"actualize-vulnerability"
];

const TargetEffectSourceIDs =  new Array(

);

function parseHTML(string) {
  const regex = /@UUID\[[\w.-]+\]\{[\w'\s]+\}/g;
  var m;
  let newHTML = string;
  while ((m = regex.exec(string)) != null) {
    const uuid = m[0].split("[")[1].split("]")[0];
    const text = m[0].split("{")[1].split("}")[0];
    const parsedUuid = foundry.utils.parseUuid(uuid);
    const subst = `<a class="content-link" draggable="true" data-uuid="${uuid}" data-id="${parsedUuid.documentId}" data-type="${parsedUuid.collection.metadata.type}" data-pack="${parsedUuid.collection.metadata.id}">${text}</a>`;
    newHTML = newHTML.replace(m, subst);
  }
  return newHTML;
}

//Gets the actualize vulnerability effects from the character
function getActorAVEffect(a, targetID) {
  if (targetID === undefined) {
    let effects = new Array();
    if (a.items !== undefined) {
      for (const item of a.items) {
        if (item.flags["actualizer"]?.EffectOrigin === a.uuid) {
          effects.push(item);
        }
      }
    } else {
      console.warn(
        `[Actualize Vulnerability] - ${a.name} has no valid items object.`,
        a
      );
    }
    return effects;
  } else if (targetID === "*") {
    let effects = new Array();
    for (let item of a.items) {
      if (TargetEffectSourceIDs.includes(item._stats.compendiumSource)) {
        effects.push(item);
      }
    }
    return effects;
  } else {
    let effects = new Array();
    if (a.items !== undefined) {
      for (const item of a.items) {
        if (item.flags["actualizer"]?.EffectOrigin === targetID) {
          effects.push(item);
        }
      }
    } else {
      console.warn(
        `[Actualize Vulnerability] - ${a.name} has no valid items object.`,
        a
      );
    }
    return effects;
  }
}

// Create an effect object, using an existing effect uuid as a template.
//
// An optional origin can be supplied, to set the actor/token/item creating the
// effect.  Origin is normally set when dragging an effect from chat, but the
// module code bypasses that step.
async function createEffectData(uuid, origin = null) {
  const effect = (await fromUuid(uuid)).toObject();
  (effect.flags.core ??= {}).sourceId = uuid;
  if (origin !== null) {
    // If context is set, then all these properties are non-optional, but can be null
    effect.system.context = {
      origin: {
        actor: origin.actor ?? null,
        token: origin.token ?? null,
        item: origin.item ?? null,
        spellcasting: origin.spellcasting ?? null,
      },
      roll: null,
      target: null,
    };
  }
  return effect;
}

// Return an array of Tokens that are the targets of the message.  Message
// should be something that has targets, like a damage roll.
function messageTargetTokens(message) {
  // It's ok to use fromUuidSync here since any tokens that are the targets of a
  // current attack will surely be in the game.
  return (
    message
      .getFlag("actualizer", "targets")
      ?.map((t) => fromUuidSync(t.tokenUuid)?.object) ?? []
  );

  // The system already has a flag, getFlag('pf2e', 'context.target'), for the
  // target of attack damage rolls.  But it's limited to one target and doesn't
  // get set on saving throw spell damage rolls.
}

// Does the actor have the feat, searching by slug
function hasFeat(actor, slug) {
  return actor.itemTypes.feat.some((feat) => feat.slug === slug);
}

function getEffectOnActor(actor, sourceId) {
  return actor?.itemTypes.effect.find((effect) => effect.sourceId === sourceId);
}

// Is the actor an actualizer?
function isActualizer(actor) {
  return (
    actor &&
    (actor.class?.slug === "actualizer" ||
      actor.rollOptions.all["class:actualizer"])
  );
}

function getTargetRollOptions(actor) {
  if (!actor) return [];
  const selfRollOptions = actor.getSelfRollOptions();
  return selfRollOptions.map((t) => t.replace(/^self/, "target"));
}

let socket;

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule("actualizer");
  socket.register("createEffectOnTarget", _socketCreateEffectOnTarget);
  socket.register("deleteAVEffect", _socketDeleteAVEffect);
  socket.register("createAVDialog", _createAVDialog);
  socket.register("AVCallback", _AVCallback);
  socket.register("createEffectsOnActors", _socketCreateEffectsOnActors);
});

function createEffectsOnActors(
  actorId,
  tokenIds,
  effectUuids,
  options,
  context
) {
  return socket.executeAsGM(
    _socketCreateEffectsOnActors,
    actorId,
    tokenIds,
    effectUuids,
    options,
    context
  );
}

function createEffectOnTarget(a, effect, avTargets) {
  let aID = a.uuid;
  return socket.executeAsGM(
    _socketCreateEffectOnTarget,
    aID,
    effect,
    avTargets
  );
}

function deleteAVEffect(effects) {
  return socket.executeAsGM(_socketDeleteAVEffect, effects);
}

function createAVDialog(sa, targ) {
  return socket.executeAsGM(
    _createAVDialog,
    game.user.id,
    sa.uuid,
    targ?.document?.uuid
  );
}

/**
 * Applies one or more effects to an actor
 * @param {string} actorId The ID for the actor creating the effect (i.e. the origin of the effect)
 * @param {[string]} tokenIds An array of target token IDs to apply effects to
 * @param {[string]} effectUuids An array of effect UUIDs to be applied
 * @param {*} options Additional options for the application of the effects
 * @param {*} context Additional context to modify the effects before being applied
 */
 
async function _socketCreateEffectsOnActors(
  actorId,
  tokenIds,
  effectUuids,
  options = {
    includeSelf: false,
    avMode: undefined,
    max: undefined,
    applyOnNoTargets: "error",
  },
  context = undefined
) {
	
  const actor = game.actors.get(actorId);
  const targets = [];
  tokenIds.forEach((t) => targets.push(game.canvas.tokens.get(t).actor));
  if (
    options.includeSelf ||
    (tokenIds.length === 0 && options.applyOnNoTargets === "self")
  )
    targets.push(actor);

  if (targets.length === 0) {
    return ui.notifications.warn("No targets to apply effects to");
  }

  const effects = [];
  for (const id of effectUuids) {
    const effect = await createEffectData(id, { actor: actor.uuid });
    if (context) {
      await effect.update(
        Object.assign(
          {
            _id: effect._id,
          },
          context
        )
      );
    }
    effects.push(effect);
  }

  for (const target of targets) {
    await target.createEmbeddedDocuments("Item", effects);
  }
}

// GM Does the AV roll, this tells the user who did the roll what happened.
function AVCallback(userId, saUuid, targUuid, roll) {
  return socket.executeAsUser(
    _AVCallback,
    userId,
    saUuid,
    targUuid,
    roll.degreeOfSuccess
  );
}

async function _AVCallback(saUuid, targUuid, degreeOfSuccess) {
  const sa = await fromUuid(saUuid);
  const targ = await fromUuid(targUuid);
  Hooks.callAll("AVResult", sa, targ, degreeOfSuccess);
}

// Create the Dialog

async function _createAVDialog(userId, saUuid, targUuid) {
  const sa = await fromUuid(saUuid);
  const skill =
    sa.skills["occultism"];
  const targ = await fromUuid(targUuid);

  const dgButtons = {
    roll: {
      label: "Roll",
      callback: async (html) => {
		const rollOModifier = $(html).find(`[id="o-modifier"]`)[0].value ?? 0;
        const rollTarget = $(html).find(`[id="target"]`)[0].value ?? 0;
        const rollDC = $(html).find(`[id="dc"]`)[0].value ?? null;
        let traits = ["concentrate"];
        const rollOptions = sa.getRollOptions(["skill-check", skill.slug]);

        // Add TokenMark roll option to roll options
        if (targ) {
          const tokenMark = targ.uuid
            ? sa.synthetics.tokenMarks.get(targ.uuid)
            : null;
          tokenMark ? rollOptions.push(`target:mark:${tokenMark}`) : null;
        }

        const outcomes = {
          criticalSuccess: game.i18n.localize(
            "actualizer.actualizeVulnerability.degreeOfSuccess.criticalSuccess"
          ),
          success: game.i18n.localize(
            "actualizer.actualizeVulnerability.degreeOfSuccess.success"
          ),
          failure: "",
          criticalFailure: game.i18n.localize(
            "actualizer.actualizeVulnerability.degreeOfSuccess.criticalFailure"
          ),
        };

        const notes = Object.entries(outcomes).map(([outcome, text]) => ({
          title: game.i18n.localize(
            "PF2E.Check.Result.Degree.Check." + outcome
          ),
          text,
          outcome: [outcome],
        }));

        let rollData = {
          actor: sa,
          type: "skill-check",
          options: [
            ...rollOptions,
            "action:actualize-vulnerability",
            getTargetRollOptions(targ?.actor),
          ].flat(),
          domains: ["all", "check", "skill-check"],
          notes,
          dc: { value: parseInt(rollDC) + parseInt(rollOModifier) },
          traits: traits,
          flavor: "stuff",
          skipDialog: "true",
          rollMode: "gmroll",
        };
        if (targ) {
          rollData = {
            ...rollData,
            target: {
              actor: targ.actor,
              token: targ,
            },
          };
        }
        const roll = await game.pf2e.Check.roll(checkModifier, rollData);
        // Need to send the result back to the user who make the request.
        AVCallback(userId, saUuid, targUuid, roll);
      },
    },
    cancel: {
      label: game.i18n.localize("actualizer.dialog.cancel"),
      callback: () => {},
    },
  };
  new Dialog({
    title: `${game.i18n.localize(
      "actualizer.actualizeVulnerability.name"
    )} (${game.i18n.localize("PF2E.TraitActualizer")}): ${sa.name}`,
    content: parseHTML(
      await renderTemplate(
        "modules/pf2e-thaum-vuln/templates/rkDialog.hbs",
        dgContent
      )
    ),
    buttons: dgButtons,
    default: "roll",
  }).render(true);
}