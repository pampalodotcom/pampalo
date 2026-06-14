/*
  Pampalo: private-money protocol diagrams
  ------------------------------------------
  Ten self-contained inline-SVG diagrams (07 is two panels) that adapt to
  light & dark. Authored as the §2–§10 narrative for the docs site's
  "How It Works" page, but every export is independent, so import whichever
  you need into any MDX page or React view.

  Usage (MDX): import what you need, render <PampaloDefs /> once near the
  top of the page (it holds the shared arrowhead markers every diagram
  references), then drop each diagram component where you want it.

    import { PampaloDefs, SumInSumOut } from '../components/diagrams'
    <PampaloDefs />
    <SumInSumOut />

  Canonical nouns (Note, leaf, Poseidon identifier, Envelope key, nullifier,
  shield/unshield/transfer, recovery phrase, …) match CONTEXT.md verbatim.
*/
import "./pampalo-diagrams.css";

/** Shared arrowhead markers. Render once near the top of each page. */
export function PampaloDefs() {
  return (
    <svg className="pampdia pd-defs" aria-hidden="true">
      <defs>
        <marker id="pd-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <polygon points="0,0 10,5 0,10 2.4,5" />
        </marker>
        <marker id="pd-arrow-pub" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <polygon points="0,0 10,5 0,10 2.4,5" />
        </marker>
        <marker id="pd-arrow-priv" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <polygon points="0,0 10,5 0,10 2.4,5" />
        </marker>
        <marker id="pd-arrow-dang" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <polygon points="0,0 10,5 0,10 2.4,5" />
        </marker>
      </defs>
    </svg>
  );
}

/** 01 · Sum in = sum out: the UTXO core */
export function SumInSumOut() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 372" role="img" aria-label="A 5 USDC input note is destroyed inside a transfer and re-emerges as a 2 USDC note to Bob plus a 3 USDC change note to Alice; two plus three equals five.">
        <text className="t-tick" x="56" y="40" fontSize="11">Inputs · destroyed</text>
        <text className="t-tick" x="408" y="40" fontSize="11">Transfer</text>
        <text className="t-tick" x="708" y="40" fontSize="11">Outputs · created</text>

        <g>
          <g className="note-a">
            <path className="node-priv note-a-body" d="M56,90 H232 a8,8 0 0 1 8,8 V198 a8,8 0 0 1 -8,8 H64 a8,8 0 0 1 -8,-8 V90 Z" />
            <path className="hair" d="M218,90 L240,112" />
            <path d="M218,90 H240 V112 Z" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.2" />
            <text className="t-tick t-priv" x="74" y="118" fontSize="10.5">Note A</text>
            <text className="t-mono" x="74" y="152" fontSize="28" fontWeight="600">5</text>
            <text className="t-sub" x="106" y="152" fontSize="14">USDC</text>
            <text className="t-sub" x="74" y="182" fontSize="12.5">owner · Alice</text>
          </g>
          <g className="note-a-stamp" transform="rotate(-7 90 232)">
            <rect x="56" y="220" width="78" height="22" rx="11" fill="none" stroke="var(--d-ink-mute)" strokeWidth="1.2" strokeDasharray="3 3" />
            <text className="t-tick t-mute" x="95" y="235" fontSize="9.5" textAnchor="middle">spent</text>
          </g>
        </g>

        <g>
          <rect className="node-2" x="404" y="92" width="152" height="152" rx="14" />
          <g className="tick">
            <path d="M404,108 V92 H420" fill="none" /><path d="M540,92 H556 V108" fill="none" />
            <path d="M556,228 V244 H540" fill="none" /><path d="M420,244 H404 V228" fill="none" />
          </g>
          <text className="t-title" x="480" y="156" fontSize="17" textAnchor="middle">Transfer</text>
          <text className="t-tick" x="480" y="180" fontSize="9.5" textAnchor="middle">spend ▸ create</text>
          <circle cx="480" cy="206" r="3" fill="var(--d-ink-faint)" />
        </g>

        <g>
          <path className="node-priv" d="M708,80 H884 a8,8 0 0 1 8,8 V160 a8,8 0 0 1 -8,8 H716 a8,8 0 0 1 -8,-8 V80 Z" />
          <path d="M870,80 H892 V102 Z" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.2" />
          <text className="t-tick t-priv" x="726" y="106" fontSize="10.5">Note B</text>
          <text className="t-mono" x="726" y="146" fontSize="22" fontWeight="600">2</text>
          <text className="t-sub" x="752" y="146" fontSize="12.5">USDC</text>
          <text className="t-priv" x="828" y="146" fontSize="13" fontWeight="600">→ Bob</text>
        </g>
        <g>
          <path className="node-priv" d="M708,196 H884 a8,8 0 0 1 8,8 V276 a8,8 0 0 1 -8,8 H716 a8,8 0 0 1 -8,-8 V196 Z" />
          <path d="M870,196 H892 V218 Z" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.2" />
          <text className="t-tick t-priv" x="726" y="222" fontSize="10.5">Note C · change</text>
          <text className="t-mono" x="726" y="262" fontSize="22" fontWeight="600">3</text>
          <text className="t-sub" x="752" y="262" fontSize="12.5">USDC</text>
          <text className="t-priv" x="820" y="262" fontSize="13" fontWeight="600">→ Alice</text>
        </g>

        <path className="flow m-flow" d="M240,148 H404" markerEnd="url(#pd-arrow)" />
        <path className="flow m-flow" d="M556,148 C610,128 650,124 708,122" markerEnd="url(#pd-arrow)" />
        <path className="flow m-flow" d="M556,188 C610,210 650,234 708,238" markerEnd="url(#pd-arrow)" />

        <circle className="m-token pd-t1a" r="5" fill="var(--d-pub)" />
        <circle className="m-token pd-t1b" r="5" fill="var(--d-pub)" />
        <circle className="m-token pd-t1c" r="5" fill="var(--d-pub)" />

        <g>
          <line className="hair" x1="146" y1="316" x2="404" y2="316" />
          <line className="hair" x1="556" y1="316" x2="800" y2="316" />
          <path className="tick" d="M146,310 V322 M800,310 V322" />
          <g transform="translate(480,316)">
            <circle r="22" fill="var(--d-surface)" stroke="var(--d-line-hi)" strokeWidth="1.5" />
            <path d="M-9,-4 H9 M-9,4 H9" stroke="var(--d-ink)" strokeWidth="2" strokeLinecap="round" />
          </g>
          <text className="t-mono" x="270" y="304" fontSize="13" textAnchor="middle">5</text>
          <text className="t-mono" x="678" y="304" fontSize="13" textAnchor="middle">2 + 3</text>
          <text className="t-tick" x="480" y="356" fontSize="10" textAnchor="middle">Σ inputs  =  Σ outputs · per asset</text>
        </g>
      </svg>
    </div>
  );
}

/** 02 · Anatomy of a note: notes & identities */
export function AnatomyOfANote() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 424" role="img" aria-label="A note's four fields are hashed by poseidon2 into a single leaf commitment; the secret is the spend key and is never published. One recovery phrase derives three identities; the Poseidon identifier is the note's owner.">
        <g>
          <rect className="node" x="36" y="40" width="300" height="196" rx="12" />
          <text className="t-title" x="56" y="72" fontSize="17">Note</text>
          <text className="t-tick" x="120" y="71" fontSize="9.5">four-tuple</text>
          <line className="hair" x1="36" y1="86" x2="336" y2="86" />

          <g fontSize="12">
            <text className="t-mono" x="56" y="112">asset_id</text>
            <text className="t-sub" x="248" y="112" textAnchor="end">ERC-20 / ETH</text>
            <text className="t-tick t-faint" x="320" y="112" textAnchor="end" fontSize="8.5">hidden</text>
            <line className="hair" x1="56" y1="124" x2="320" y2="124" />

            <text className="t-mono" x="56" y="148">asset_amount</text>
            <text className="t-sub" x="248" y="148" textAnchor="end">≤ 128 bits</text>
            <text className="t-tick t-faint" x="320" y="148" textAnchor="end" fontSize="8.5">hidden</text>
            <line className="hair" x1="56" y1="160" x2="320" y2="160" />

            <text className="t-mono" x="56" y="184">owner</text>
            <text className="t-sub t-priv" x="248" y="184" textAnchor="end" fontWeight="600" fontSize="10.5">Poseidon identifier</text>
            <text className="t-tick t-faint" x="320" y="196" textAnchor="end" fontSize="8.5">hidden</text>
            <line className="hair" x1="56" y1="196" x2="320" y2="196" />

            <rect x="44" y="204" width="284" height="26" rx="7" fill="var(--d-warn-soft)" />
            <g transform="translate(56,210)">
              <rect x="0" y="6" width="13" height="10" rx="2.3" fill="none" stroke="var(--d-warn)" strokeWidth="1.4" />
              <path d="M2.5,6 V4.4 a4,4 0 0 1 8,0 V6" fill="none" stroke="var(--d-warn)" strokeWidth="1.4" />
            </g>
            <text className="t-mono t-warn" x="78" y="221" fontWeight="600">secret</text>
            <text className="t-tick t-warn" x="320" y="221" textAnchor="end" fontSize="8.5">never on-chain · spend key</text>
          </g>
        </g>

        <polygon className="node-2" points="430,98 453,112 453,140 430,154 407,140 407,112" />
        <text className="t-mono" x="430" y="129" fontSize="10.5" textAnchor="middle" letterSpacing="1.2">poseidon2</text>
        <text className="t-tick t-faint" x="430" y="176" fontSize="8.5" textAnchor="middle">SNARK-friendly hash</text>

        <g>
          <rect className="node-priv" x="512" y="92" width="224" height="68" rx="12" />
          <text className="t-tick t-priv" x="532" y="116" fontSize="9.5">leaf · commitment</text>
          <text className="t-mono" x="532" y="142" fontSize="15">0x9f3a…b27e</text>
        </g>
        <text className="t-sub" x="624" y="186" fontSize="11.5" textAnchor="middle">→ inserted into the Merkle tree</text>

        <path className="flow" d="M336,126 H405" markerEnd="url(#pd-arrow)" />
        <path className="flow" d="M455,126 H512" markerEnd="url(#pd-arrow)" />

        <line className="hair dash" x1="36" y1="266" x2="924" y2="266" />
        <text className="t-tick" x="36" y="294" fontSize="10">One recovery phrase → three identities</text>

        <rect className="node-2" x="36" y="326" width="150" height="64" rx="12" />
        <text className="t-mono" x="111" y="354" fontSize="11" textAnchor="middle">recovery</text>
        <text className="t-mono" x="111" y="372" fontSize="11" textAnchor="middle">phrase</text>

        <path className="flow-priv" d="M186,351 C243,351 243,316 300,316" markerEnd="url(#pd-arrow-priv)" />
        <path className="flow" d="M186,358 H300" markerEnd="url(#pd-arrow)" />
        <path className="flow" d="M186,365 C243,365 243,400 300,400" markerEnd="url(#pd-arrow)" />

        <g>
          <rect className="node-priv" x="300" y="300" width="234" height="32" rx="9" />
          <text className="t-mono t-priv" x="316" y="320" fontSize="11.5" fontWeight="600">Poseidon identifier</text>
          <text className="t-tick t-priv" x="518" y="320" fontSize="8" textAnchor="end">= note owner</text>
        </g>
        <g>
          <rect className="node" x="300" y="342" width="190" height="32" rx="9" />
          <text className="t-mono" x="316" y="362" fontSize="11.5">EVM address</text>
          <text className="t-tick t-faint" x="474" y="362" fontSize="8" textAnchor="end">public · gas</text>
        </g>
        <g>
          <rect className="node" x="300" y="384" width="190" height="32" rx="9" />
          <text className="t-mono" x="316" y="404" fontSize="11.5">Envelope key</text>
          <text className="t-tick t-faint" x="474" y="404" fontSize="8" textAnchor="end">secp256k1</text>
        </g>

        <path className="flow-priv dash" d="M417,300 C417,240 370,184 270,184" markerEnd="url(#pd-arrow-priv)" opacity="0.7" />
      </svg>
    </div>
  );
}

/** Account · one recovery phrase → three identities.
 *  The identity-derivation half of AnatomyOfANote, extracted as a
 *  standalone figure for the /account page: each identity is a card with
 *  a checklist of what it does. */
export function AccountIdentities() {
  const RECOV_X = 28;
  const LEFT_W = 160;
  const CARD_X = 250;
  const CARD_W = 300;
  const CARD_H = 108;
  const GAP = 22;
  const TOP = 44;

  const cards = [
    {
      priv: true,
      title: "Poseidon identifier",
      items: [
        "Owns your private notes",
        "Proven in zero-knowledge",
        "Unlinkable to your EVM address",
      ],
    },
    {
      priv: false,
      title: "EVM address",
      items: [
        "Pays gas, holds public balances",
        "Your cleartext on-chain handle",
        "The only identity seen in the open",
      ],
    },
    {
      priv: false,
      title: "Envelope key",
      items: [
        "Receives notes others encrypt to you",
        "A secp256k1 public key",
        "Only you hold the key to decrypt",
      ],
    },
  ];

  const cardY = (i: number): number => TOP + i * (CARD_H + GAP);
  const cardMid = (i: number): number => cardY(i) + CARD_H / 2;
  const blockH = cards.length * CARD_H + (cards.length - 1) * GAP;
  const recovMidY = TOP + blockH / 2;
  const recovH = 64;
  const VB_W = CARD_X + CARD_W + 10;
  const VB_H = TOP + blockH + 16;

  return (
    <div className="pampdia">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="One recovery phrase deterministically derives three identities. The Poseidon identifier owns your private notes, is proven in zero-knowledge, and is unlinkable to your EVM address. The EVM address pays gas, holds public balances, and is your only cleartext on-chain handle. The Envelope key receives notes others encrypt to you using a secp256k1 public key only you can decrypt."
      >
        <text className="t-tick" x={RECOV_X} y="22" fontSize="10">
          One recovery phrase → three identities
        </text>

        <rect
          className="node-2"
          x={RECOV_X}
          y={recovMidY - recovH / 2}
          width={LEFT_W}
          height={recovH}
          rx="12"
        />
        <text className="t-mono" x={RECOV_X + LEFT_W / 2} y={recovMidY - 4} fontSize="11" textAnchor="middle">
          recovery
        </text>
        <text className="t-mono" x={RECOV_X + LEFT_W / 2} y={recovMidY + 14} fontSize="11" textAnchor="middle">
          phrase
        </text>

        {cards.map((c, i) => {
          const x1 = RECOV_X + LEFT_W;
          const y1 = recovMidY + (i - 1) * 8;
          const y2 = cardMid(i);
          const mid = (x1 + CARD_X) / 2;
          const d =
            y1 === y2
              ? `M${x1},${y1} H${CARD_X}`
              : `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${CARD_X},${y2}`;
          return (
            <path
              key={`flow-${i}`}
              className={c.priv ? "flow-priv" : "flow"}
              d={d}
              markerEnd={`url(#pd-arrow${c.priv ? "-priv" : ""})`}
            />
          );
        })}

        {cards.map((c, i) => {
          const y = cardY(i);
          const px = CARD_X + 18;
          return (
            <g key={`card-${i}`}>
              <rect
                className={c.priv ? "node-priv" : "node"}
                x={CARD_X}
                y={y}
                width={CARD_W}
                height={CARD_H}
                rx="12"
              />
              <text
                className={c.priv ? "t-mono t-priv" : "t-mono"}
                x={px}
                y={y + 27}
                fontSize="13"
                fontWeight={c.priv ? 600 : 400}
              >
                {c.title}
              </text>
              <line className="hair" x1={px} y1={y + 40} x2={CARD_X + CARD_W - 18} y2={y + 40} />
              {c.items.map((it, j) => {
                const iy = y + 60 + j * 18;
                return (
                  <g key={`item-${i}-${j}`}>
                    <path
                      className="flow-priv"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={`M${px},${iy - 3.5} l3,3.5 l6,-7`}
                    />
                    <text className="t-sub" x={px + 16} y={iy} fontSize="10.5">
                      {it}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 03 · The note tree: Merkle tree & epochs */
export function NoteTree() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 470" role="img" aria-label="A binary Merkle tree of leaves. One leaf's membership path is highlighted up to the root, with a sibling hash at each level. Empty slots hold ZERO_LEAF. Below, a filmstrip shows epoch rollover from a full frozen tree to a filling tree to an empty tree.">
        <g transform="translate(640,30)">
          <circle cx="8" cy="6" r="5" className="node-priv" />
          <text className="t-tick" x="20" y="9" fontSize="9">on the membership path</text>
          <rect x="2" y="22" width="12" height="10" rx="2" fill="none" stroke="var(--d-priv-line)" strokeWidth="1.4" strokeDasharray="3 2" />
          <text className="t-tick" x="20" y="31" fontSize="9">sibling hash (in the proof)</text>
          <rect x="2" y="44" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
          <text className="t-tick t-faint" x="20" y="53" fontSize="9">empty slot · ZERO_LEAF</text>
        </g>

        <text className="t-tick t-faint" x="20" y="58" fontSize="9">root</text>
        <text className="t-tick t-faint" x="20" y="148" fontSize="9">⋮</text>
        <text className="t-tick t-faint" x="20" y="258" fontSize="9">leaves</text>

        <g className="hair" fill="none">
          <path d="M313,68 L181,88" />
          <path className="dash" d="M181,118 L115,168" />
          <path className="dash" d="M181,118 L247,168" />
          <path className="dash" d="M445,118 L511,168" />
          <path d="M115,198 L82,236" />
          <path d="M115,198 L148,236" />
          <path d="M247,198 L214,236" />
          <path d="M247,198 L280,236" />
          <path d="M379,198 L346,236" />
          <path d="M511,198 L478,236" />
          <path d="M511,198 L544,236" />
        </g>

        <g className="flow-priv m-pulse" fill="none" strokeWidth="2">
          <path d="M412,234 L379,198" />
          <path className="dash" d="M379,168 L445,118" />
          <path d="M445,88 L313,68" />
        </g>

        <rect className="node-priv" x="249" y="38" width="128" height="30" rx="8" />
        <text className="t-mono t-priv" x="313" y="57" fontSize="11" textAnchor="middle" fontWeight="600">root</text>
        <text className="t-tick t-faint" x="385" y="33" fontSize="8.5">32-byte fingerprint · valid forever</text>

        <rect className="node" x="161" y="88" width="40" height="30" rx="7" />
        <rect x="167" y="92" width="28" height="22" rx="4" fill="none" stroke="var(--d-priv-line)" strokeWidth="1.4" strokeDasharray="3 2" />
        <rect className="node-priv" x="425" y="88" width="40" height="30" rx="7" />
        <text className="t-tick t-faint" x="148" y="106" fontSize="8" textAnchor="end">sib</text>

        <text className="t-faint" x="181" y="156" fontSize="16" textAnchor="middle">⋮</text>
        <text className="t-faint" x="445" y="156" fontSize="16" textAnchor="middle">⋮</text>
        <text className="t-tick t-faint" x="313" y="150" fontSize="8.5" textAnchor="middle">levels 2–10 omitted</text>

        <rect className="node" x="95" y="168" width="40" height="30" rx="7" />
        <rect className="node" x="227" y="168" width="40" height="30" rx="7" />
        <rect className="node-priv" x="359" y="168" width="40" height="30" rx="7" />
        <rect className="node" x="491" y="168" width="40" height="30" rx="7" />
        <rect x="497" y="172" width="28" height="22" rx="4" fill="none" stroke="var(--d-priv-line)" strokeWidth="1.4" strokeDasharray="3 2" />

        <g>
          <rect className="node" x="60" y="236" width="44" height="34" rx="7" />
          <rect className="node" x="126" y="236" width="44" height="34" rx="7" />
          <rect className="node" x="192" y="236" width="44" height="34" rx="7" />
          <rect className="node" x="258" y="236" width="44" height="34" rx="7" />
          <rect className="node" x="324" y="236" width="44" height="34" rx="7" />
          <rect x="328" y="240" width="36" height="26" rx="4" fill="none" stroke="var(--d-priv-line)" strokeWidth="1.4" strokeDasharray="3 2" />
          <rect className="node-priv" x="390" y="234" width="44" height="38" rx="8" />
          <text className="t-tick t-priv" x="412" y="257" fontSize="8" textAnchor="middle" fontWeight="600">my note</text>
          <rect x="456" y="236" width="44" height="34" rx="7" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
          <rect x="522" y="236" width="44" height="34" rx="7" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
          <text className="t-tick t-faint" x="544" y="288" fontSize="8" textAnchor="middle">ZERO_LEAF</text>
        </g>

        <text className="t-sub" x="313" y="306" fontSize="11.5" textAnchor="middle">Re-hash my note up the path → reproduces a known <tspan className="t-priv" fontWeight="600">root</tspan>. Proves membership, reveals nothing.</text>

        <line className="hair dash" x1="36" y1="332" x2="924" y2="332" />
        <text className="t-tick" x="36" y="356" fontSize="10">Tree rotation · epochs (append-only, old roots never expire)</text>

        <g transform="translate(60,372)">
          <rect className="node-2" x="0" y="0" width="244" height="80" rx="12" />
          <text className="t-mono" x="16" y="22" fontSize="11">Tree 0</text>
          <text className="t-tick t-priv" x="228" y="22" fontSize="8.5" textAnchor="end">full · root frozen ✓</text>
          <polygon points="122,34 158,68 86,68" className="node-priv" />
          <g>
            <rect className="node-priv" x="92" y="62" width="12" height="10" rx="2" />
            <rect className="node-priv" x="108" y="62" width="12" height="10" rx="2" />
            <rect className="node-priv" x="124" y="62" width="12" height="10" rx="2" />
            <rect className="node-priv" x="140" y="62" width="12" height="10" rx="2" />
          </g>
        </g>

        <g transform="translate(358,372)">
          <rect className="node-2" x="0" y="0" width="244" height="80" rx="12" />
          <text className="t-mono" x="16" y="22" fontSize="11">Tree 1</text>
          <text className="t-tick t-warn" x="228" y="22" fontSize="8.5" textAnchor="end">filling · active</text>
          <polygon points="122,34 158,68 86,68" className="node" fill="var(--d-surface)" />
          <g>
            <rect className="node-priv" x="92" y="62" width="12" height="10" rx="2" />
            <rect className="node-priv" x="108" y="62" width="12" height="10" rx="2" />
            <rect x="124" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
            <rect x="140" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
          </g>
          <g className="m-drop">
            <rect className="node-priv" x="118" y="34" width="12" height="10" rx="2" />
          </g>
          <text className="t-tick t-faint" x="170" y="50" fontSize="8">(tree 1, leaf 37)</text>
        </g>

        <g transform="translate(656,372)">
          <rect className="node-2" x="0" y="0" width="244" height="80" rx="12" />
          <text className="t-mono t-mute" x="16" y="22" fontSize="11">Tree 2</text>
          <text className="t-tick t-faint" x="228" y="22" fontSize="8.5" textAnchor="end">empty · nextIndex 0</text>
          <polygon points="122,34 158,68 86,68" fill="none" stroke="var(--d-line)" strokeWidth="1.2" strokeDasharray="3 3" />
          <g>
            <rect x="92" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
            <rect x="108" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
            <rect x="124" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
            <rect x="140" y="62" width="12" height="10" rx="2" fill="var(--d-surface-2)" stroke="var(--d-line)" strokeWidth="1" />
          </g>
        </g>

        <path className="flow" d="M308,412 H354" markerEnd="url(#pd-arrow)" />
        <path className="flow" d="M606,412 H652" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-faint" x="331" y="402" fontSize="7.5" textAnchor="middle">full</text>
        <text className="t-tick t-faint" x="629" y="402" fontSize="7.5" textAnchor="middle">full</text>
      </svg>
    </div>
  );
}

/** 04 · Spend = nullify: double-spend defence */
export function SpendNullify() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 348" role="img" aria-label="The note leaf stays in the append-only tree. Spending it publishes a nullifier that drops into the nullifierUsed set. A second spend of the same note produces the same nullifier and is rejected because it is already present.">
        <g>
          <polygon points="118,70 150,98 86,98" fill="none" stroke="var(--d-line-hi)" strokeWidth="1.2" />
          <rect className="node-priv" x="44" y="150" width="160" height="74" rx="12" />
          <text className="t-tick t-priv" x="64" y="176" fontSize="9.5">note leaf</text>
          <text className="t-mono" x="64" y="200" fontSize="13">0x9f3a…</text>
          <text className="t-tick t-faint" x="124" y="244" fontSize="8.5" textAnchor="middle">stays in tree · untouched</text>
        </g>

        <path className="flow" d="M204,166 C250,150 270,120 300,110" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-priv" x="250" y="120" fontSize="8.5">spend</text>
        <g>
          <rect className="node" x="300" y="80" width="170" height="62" rx="12" />
          <text className="t-tick" x="318" y="104" fontSize="9">nullifier</text>
          <text className="t-mono" x="318" y="126" fontSize="13">0x4c…e9</text>
          <circle cx="452" cy="92" r="9" className="node-priv" />
          <path d="M448,92 l3,3 l5,-6" fill="none" stroke="var(--d-priv)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <path className="flow-priv m-flow" d="M470,108 C560,118 600,118 668,118" markerEnd="url(#pd-arrow-priv)" />
        <circle className="m-token pd-t4" r="5" fill="var(--d-priv)" />

        <path className="flow dash" d="M204,208 C250,224 270,250 300,262" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-warn" x="216" y="258" fontSize="8.5">spend again</text>
        <g>
          <rect className="node-2" x="300" y="232" width="170" height="62" rx="12" />
          <text className="t-tick" x="318" y="256" fontSize="9">same nullifier</text>
          <text className="t-mono" x="318" y="278" fontSize="13">0x4c…e9</text>
        </g>
        <path className="flow-pub dash" d="M470,262 C520,250 555,205 590,176" markerEnd="url(#pd-arrow-pub)" />

        <g transform="translate(600,168)">
          <circle r="12" fill="var(--d-warn-soft)" stroke="var(--d-warn)" strokeWidth="1.5" />
          <path d="M-4.5,-4.5 L4.5,4.5 M4.5,-4.5 L-4.5,4.5" stroke="var(--d-warn)" strokeWidth="2" strokeLinecap="round" />
        </g>
        <text className="t-tick t-warn" x="600" y="200" fontSize="8.5" textAnchor="middle">already spent</text>

        <g>
          <rect className="node" x="668" y="56" width="248" height="180" rx="14" />
          <text className="t-mono" x="690" y="82" fontSize="12">nullifierUsed</text>
          <text className="t-tick t-faint" x="690" y="98" fontSize="8">spent fingerprints · a separate set</text>
          <g fontSize="11.5">
            <rect className="node-2" x="690" y="110" width="204" height="26" rx="7" />
            <text className="t-mono t-mute" x="704" y="127">0x71…a2</text>
            <rect className="node-priv" x="690" y="142" width="204" height="26" rx="7" />
            <text className="t-mono" x="704" y="159">0x4c…e9</text>
            <text className="t-tick t-priv" x="880" y="159" fontSize="8" textAnchor="end">new</text>
            <rect className="node-2" x="690" y="174" width="204" height="26" rx="7" />
            <text className="t-mono t-mute" x="704" y="191">0xb3…07</text>
          </g>
        </g>

        <text className="t-sub" x="480" y="328" fontSize="11.5" textAnchor="middle">nullifier = poseidon2( leaf_index, owner, secret, asset_id, asset_amount )</text>
      </svg>
    </div>
  );
}

/** 05 · The proof as a sealed box: zero-knowledge */
export function SealedProof() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 404" role="img" aria-label="Private witnesses enter the sealed left side of the Transfer proof box. The box face lists five guarantees it checks. Only public inputs (root, nullifiers, output hashes) come out the right side, which is all the chain sees. A lower panel shows amounts bounded to 128 bits to block the field-overflow mint.">
        <text className="t-tick t-warn" x="30" y="34" fontSize="9.5">Private witnesses · never leave the client</text>
        <g fontSize="11">
          <rect className="node-2" x="30" y="50" width="184" height="30" rx="8" /><text className="t-mono" x="46" y="70">input notes</text>
          <rect className="node-2" x="30" y="92" width="184" height="30" rx="8" /><text className="t-mono" x="46" y="112">secrets</text>
          <rect className="node-2" x="30" y="134" width="184" height="30" rx="8" /><text className="t-mono" x="46" y="154">Merkle paths</text>
          <rect className="node-2" x="30" y="176" width="184" height="30" rx="8" /><text className="t-mono" x="46" y="196">output notes</text>
        </g>

        <g className="flow m-flow">
          <path d="M214,65  C260,80 270,110 300,128" />
          <path d="M214,107 C260,112 272,120 300,134" />
          <path d="M214,149 C260,150 272,148 300,150" />
          <path d="M214,191 C260,176 272,168 300,162" />
        </g>

        <rect className="node" x="318" y="46" width="300" height="252" rx="16" />
        <line x1="318" y1="46" x2="318" y2="298" stroke="var(--d-warn)" strokeWidth="2.5" />
        <g transform="translate(305,138)">
          <rect x="0" y="9" width="26" height="20" rx="4" fill="var(--d-surface)" stroke="var(--d-warn)" strokeWidth="1.6" />
          <path d="M5,9 V5 a8,8 0 0 1 16,0 V9" fill="none" stroke="var(--d-warn)" strokeWidth="1.6" />
          <circle cx="13" cy="18" r="2.4" fill="var(--d-warn)" />
        </g>
        <text className="t-title" x="468" y="78" fontSize="16" textAnchor="middle">Transfer proof</text>
        <text className="t-tick t-faint" x="468" y="96" fontSize="8.5" textAnchor="middle">checks, then reveals nothing else</text>

        <g fontSize="10.5">
          <g transform="translate(344,120)">
            <circle r="8" className="node-priv" /><path d="M-3.6,0 l2.6,2.8 l4.4,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text className="t-lab" x="362" y="124">owned <tspan className="t-mute">· poseidon2(owner_secret)=owner</tspan></text>
          <g transform="translate(344,152)">
            <circle r="8" className="node-priv" /><path d="M-3.6,0 l2.6,2.8 l4.4,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text className="t-lab" x="362" y="156">in-tree <tspan className="t-mute">· leaf re-hashes to root</tspan></text>
          <g transform="translate(344,184)">
            <circle r="8" className="node-priv" /><path d="M-3.6,0 l2.6,2.8 l4.4,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text className="t-lab" x="362" y="188">balanced <tspan className="t-mute">· Σin = Σout, per asset</tspan></text>
          <g transform="translate(344,216)">
            <circle r="8" className="node-priv" /><path d="M-3.6,0 l2.6,2.8 l4.4,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text className="t-lab" x="362" y="220">nullifier <tspan className="t-mute">· matches the note</tspan></text>
          <g transform="translate(344,248)">
            <circle r="8" className="node-priv" /><path d="M-3.6,0 l2.6,2.8 l4.4,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text className="t-lab" x="362" y="252">outputs committed <tspan className="t-mute">· = output_hashes</tspan></text>
        </g>

        <text className="t-tick t-priv" x="930" y="34" fontSize="9.5" textAnchor="end">Public inputs · all the chain sees</text>
        <g className="flow-priv">
          <path d="M618,108 H736" markerEnd="url(#pd-arrow-priv)" />
          <path d="M618,172 H736" markerEnd="url(#pd-arrow-priv)" />
          <path d="M618,236 H736" markerEnd="url(#pd-arrow-priv)" />
        </g>
        <g fontSize="11">
          <rect className="node-priv" x="740" y="94" width="190" height="30" rx="8" /><text className="t-mono t-priv" x="756" y="114">root</text>
          <rect className="node-priv" x="740" y="158" width="190" height="30" rx="8" /><text className="t-mono t-priv" x="756" y="178">nullifiers[ ]</text>
          <rect className="node-priv" x="740" y="222" width="190" height="30" rx="8" /><text className="t-mono t-priv" x="756" y="242">output_hashes[ ]</text>
        </g>

        <line className="hair dash" x1="30" y1="324" x2="930" y2="324" />
        <text className="t-tick" x="30" y="348" fontSize="10">Field-overflow guard</text>
        <text className="t-sub" x="212" y="348" fontSize="11">amounts bounded to 128 bits, blocking the <tspan className="t-mono">p − N</tspan> mint trick</text>

        <g transform="translate(610,338)">
          <line x1="0" y1="6" x2="200" y2="6" stroke="var(--d-priv-line)" strokeWidth="2" />
          <line x1="0" y1="1" x2="0" y2="11" className="tick" />
          <line x1="200" y1="1" x2="200" y2="11" className="tick" />
          <text className="t-mono t-priv" x="0" y="26" fontSize="9">0</text>
          <text className="t-mono t-priv" x="200" y="26" fontSize="9" textAnchor="end">2¹²⁸</text>
          <g transform="translate(244,6)">
            <line x1="-18" y1="-12" x2="-18" y2="12" stroke="var(--d-warn)" strokeWidth="2" />
            <text className="t-mono t-warn" x="0" y="4" fontSize="10">p − N</text>
            <path d="M-12,-8 L40,8 M40,-8 L-12,8" stroke="var(--d-warn)" strokeWidth="1.4" opacity="0.55" />
          </g>
        </g>
      </svg>
    </div>
  );
}

/** 06 · Sending a note's secret: encrypted payloads */
export function SendingASecret() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 232" role="img" aria-label="The note creator encrypts the secret to the recipient's Envelope key. The ciphertext rides on-chain with the leaf; the server and relayer see only ciphertext. The recipient's wallet scans events, decrypts with its Envelope private key, and files the note locally.">
        <text className="t-tick t-faint" x="24" y="34" fontSize="9">Sender · creator</text>
        <text className="t-tick t-faint" x="400" y="34" fontSize="9">On-chain · public</text>
        <text className="t-tick t-faint" x="588" y="34" fontSize="9">Recipient · wallet</text>
        <line className="hair dash" x1="388" y1="44" x2="388" y2="214" />
        <line className="hair dash" x1="576" y1="44" x2="576" y2="214" />

        <rect className="node" x="24" y="58" width="168" height="120" rx="12" />
        <text className="t-tick t-priv" x="42" y="84" fontSize="9">new note</text>
        <text className="t-mono" x="42" y="108" fontSize="12">0x9f3a…</text>
        <rect x="42" y="124" width="132" height="26" rx="7" fill="var(--d-warn-soft)" />
        <g transform="translate(52,130)"><rect x="0" y="5" width="11" height="9" rx="2" fill="none" stroke="var(--d-warn)" strokeWidth="1.3" /><path d="M2,5 V3.6 a3.5,3.5 0 0 1 7,0 V5" fill="none" stroke="var(--d-warn)" strokeWidth="1.3" /></g>
        <text className="t-mono t-warn" x="70" y="141" fontSize="10">secret</text>

        <path className="flow" d="M192,118 H212" markerEnd="url(#pd-arrow)" />
        <rect className="node-2" x="212" y="58" width="168" height="120" rx="12" />
        <g transform="translate(286,76)"><rect x="0" y="9" width="22" height="17" rx="3.5" fill="var(--d-surface)" stroke="var(--d-warn)" strokeWidth="1.6" /><path d="M4,9 V5.5 a7,7 0 0 1 14,0 V9" fill="none" stroke="var(--d-warn)" strokeWidth="1.6" /></g>
        <text className="t-lab" x="296" y="124" fontSize="11" textAnchor="middle">ECIES encrypt</text>
        <text className="t-tick t-faint" x="296" y="140" fontSize="8" textAnchor="middle">to recipient's</text>
        <text className="t-tick t-priv" x="296" y="153" fontSize="8.5" textAnchor="middle" fontWeight="600">Envelope key (public)</text>
        <text className="t-mono t-mute" x="296" y="170" fontSize="9" textAnchor="middle">→ 0x7c1f…ad</text>

        <path className="flow" d="M380,118 H400" markerEnd="url(#pd-arrow)" />
        <rect className="node" x="400" y="58" width="156" height="120" rx="12" />
        <polygon points="478,74 502,96 454,96" className="node-priv" />
        <text className="t-tick t-priv" x="478" y="116" fontSize="8.5" textAnchor="middle">leaf inserted</text>
        <rect className="node-2" x="416" y="128" width="124" height="36" rx="8" />
        <text className="t-mono" x="478" y="143" fontSize="9" textAnchor="middle">NotePayload</text>
        <text className="t-tick t-faint" x="478" y="157" fontSize="7.5" textAnchor="middle">encryptedPayload</text>

        <g transform="translate(408,196)">
          <path d="M0,4 q8,-9 16,0 q-8,9 -16,0 Z" fill="none" stroke="var(--d-ink-mute)" strokeWidth="1.3" />
          <circle cx="8" cy="4" r="2.2" fill="var(--d-ink-mute)" />
        </g>
        <text className="t-tick t-faint" x="430" y="203" fontSize="8">server / relayer reads</text>
        <text className="t-mono t-priv" x="430" y="216" fontSize="8.5">0x7c1f…ad ✓ ciphertext</text>

        <path className="flow-priv m-flow" d="M556,118 H600" markerEnd="url(#pd-arrow-priv)" />
        <circle className="m-token pd-t6" r="5" fill="var(--d-priv)" />
        <rect className="node" x="600" y="58" width="168" height="120" rx="12" />
        <g transform="translate(620,78) " className="m-pulse"><circle cx="6" cy="6" r="6" fill="none" stroke="var(--d-priv)" strokeWidth="1.5" /><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="var(--d-priv)" strokeWidth="1.6" strokeLinecap="round" /></g>
        <text className="t-tick t-priv" x="646" y="90" fontSize="9">scan events</text>

        <g transform="translate(734,74)"><rect x="0" y="9" width="22" height="17" rx="3.5" fill="var(--d-surface)" stroke="var(--d-priv)" strokeWidth="1.6" /><path d="M4,9 V5.5 a7,7 0 0 1 13,-2.5" fill="none" stroke="var(--d-priv)" strokeWidth="1.6" /></g>
        <text className="t-lab" x="684" y="126" fontSize="11" textAnchor="middle">ECIES decrypt</text>
        <text className="t-tick t-faint" x="684" y="140" fontSize="8" textAnchor="middle">with Envelope</text>
        <text className="t-tick t-priv" x="684" y="153" fontSize="8.5" textAnchor="middle" fontWeight="600">private key</text>
        <text className="t-mono t-warn" x="684" y="170" fontSize="9" textAnchor="middle">→ secret revealed</text>

        <path className="flow-priv" d="M768,118 H792" markerEnd="url(#pd-arrow-priv)" />
        <rect className="node-priv" x="792" y="86" width="144" height="64" rx="12" />
        <text className="t-lab" x="864" y="114" fontSize="11" textAnchor="middle">file note locally</text>
        <text className="t-tick t-priv" x="864" y="132" fontSize="8.5" textAnchor="middle">IndexedDB</text>
      </svg>
    </div>
  );
}

/** 07a · Contract topology */
export function ContractTopology() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 272" role="img" aria-label="Four entry points (shield, transfer, unshield, unshield bundled) call the Pampalo contract hub, which mutates the Merkle tree and nullifier set and routes each proof to one of four verifier contracts.">
        <g fontSize="11.5">
          <rect className="node-pub" x="20" y="40" width="156" height="38" rx="9" /><text className="t-mono t-pub" x="36" y="63">shield</text><text className="t-tick t-faint" x="166" y="63" fontSize="7" textAnchor="end">pub→priv</text>
          <rect className="node-priv" x="20" y="88" width="156" height="38" rx="9" /><text className="t-mono t-priv" x="36" y="111">transfer</text><text className="t-tick t-faint" x="166" y="111" fontSize="7" textAnchor="end">priv→priv</text>
          <rect className="node-pub" x="20" y="136" width="156" height="38" rx="9" /><text className="t-mono t-pub" x="36" y="159">unshield</text><text className="t-tick t-faint" x="166" y="159" fontSize="7" textAnchor="end">priv→pub</text>
          <rect className="node-pub" x="20" y="184" width="156" height="38" rx="9" /><text className="t-mono t-pub" x="36" y="207">unshield bundled</text>
        </g>
        <g className="flow">
          <path d="M176,59  C206,66 214,120 244,124" markerEnd="url(#pd-arrow)" />
          <path d="M176,107 C206,112 220,124 244,128" markerEnd="url(#pd-arrow)" />
          <path d="M176,155 C206,150 220,136 244,134" markerEnd="url(#pd-arrow)" />
          <path d="M176,203 C206,196 216,142 244,138" markerEnd="url(#pd-arrow)" />
        </g>

        <rect className="node" x="246" y="34" width="288" height="204" rx="16" />
        <text className="t-title" x="390" y="64" fontSize="16" textAnchor="middle">Pampalo.sol</text>
        <text className="t-tick t-faint" x="390" y="82" fontSize="8" textAnchor="middle">extends PoseidonMerkleTree · AccessControl</text>
        <text className="t-tick" x="266" y="108" fontSize="8.5">state that mutates</text>
        <rect className="node-priv" x="266" y="116" width="248" height="34" rx="9" />
        <text className="t-mono" x="280" y="132" fontSize="10.5">Merkle tree</text>
        <text className="t-tick t-faint" x="500" y="132" fontSize="8" textAnchor="end">leaves · roots · epochs</text>
        <rect className="node-priv" x="266" y="158" width="248" height="34" rx="9" />
        <text className="t-mono" x="280" y="174" fontSize="10.5">nullifier set</text>
        <text className="t-tick t-faint" x="500" y="174" fontSize="8" textAnchor="end">spent fingerprints</text>
        <text className="t-tick" x="390" y="220" fontSize="8.5" textAnchor="middle">+ shield queue · USD caps · roles · kill switch</text>

        <text className="t-tick t-faint" x="630" y="28" fontSize="8">verify(proof, publicInputs)</text>
        <g className="flow-priv">
          <path d="M534,80  C580,72 600,56 626,52" markerEnd="url(#pd-arrow-priv)" />
          <path d="M534,108 C580,104 600,104 626,104" markerEnd="url(#pd-arrow-priv)" />
          <path d="M534,150 C580,154 600,158 626,158" markerEnd="url(#pd-arrow-priv)" />
          <path d="M534,180 C580,194 600,206 626,210" markerEnd="url(#pd-arrow-priv)" />
        </g>
        <g fontSize="11">
          <rect className="node" x="630" y="34" width="300" height="40" rx="10" /><text className="t-mono" x="646" y="59">Deposit Verifier</text><text className="t-tick t-faint" x="914" y="59" fontSize="8" textAnchor="end">(shield)</text>
          <rect className="node" x="630" y="86" width="300" height="40" rx="10" /><text className="t-mono" x="646" y="111">Transfer Verifier</text><text className="t-tick t-faint" x="914" y="111" fontSize="8" textAnchor="end">(transfer)</text>
          <rect className="node" x="630" y="138" width="300" height="40" rx="10" /><text className="t-mono" x="646" y="163">Withdraw Verifier</text><text className="t-tick t-faint" x="914" y="163" fontSize="8" textAnchor="end">(unshield)</text>
          <rect className="node" x="630" y="190" width="300" height="40" rx="10" /><text className="t-mono" x="646" y="215">TransferExternal Verifier</text><text className="t-tick t-faint" x="914" y="215" fontSize="8" textAnchor="end">(bundled)</text>
        </g>
      </svg>
    </div>
  );
}

/** 07b · Shield-queue state machine */
export function ShieldQueueMachine() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 280" role="img" aria-label="A shield call enters a pending escrowed state with a one-hour wait. After the wait anyone can execute it and the leaf is inserted. The shielder can cancel before unlock, a vigilant citizen can contest it, and a booth operator can execute immediately, bypassing the wait.">
        <rect className="node-pub" x="20" y="92" width="120" height="44" rx="11" />
        <text className="t-mono t-pub" x="80" y="119" fontSize="12" textAnchor="middle">shield()</text>
        <path className="flow" d="M140,114 H184" markerEnd="url(#pd-arrow)" />

        <rect className="node" x="186" y="74" width="214" height="82" rx="14" />
        <text className="t-title" x="293" y="102" fontSize="14" textAnchor="middle">Queued</text>
        <text className="t-tick" x="293" y="122" fontSize="8.5" textAnchor="middle">PendingShield · escrowed</text>
        <text className="t-mono t-warn" x="293" y="140" fontSize="9.5" textAnchor="middle">unlockTime = now + 1h</text>

        <path className="flow-priv m-flow" d="M400,108 H612" markerEnd="url(#pd-arrow-priv)" />
        <g transform="translate(496,108)">
          <circle r="15" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.5" />
          <path d="M0,-8 V0 L5,4" fill="none" stroke="var(--d-priv)" strokeWidth="1.6" strokeLinecap="round" />
        </g>
        <text className="t-tick t-priv" x="496" y="88" fontSize="8" textAnchor="middle">wait 1h</text>
        <text className="t-tick t-faint" x="496" y="138" fontSize="7.5" textAnchor="middle">executeShield · anyone</text>
        <rect className="node-priv" x="614" y="80" width="200" height="64" rx="13" />
        <text className="t-title t-priv" x="714" y="106" fontSize="14" textAnchor="middle">Executed</text>
        <text className="t-tick t-priv" x="714" y="126" fontSize="8.5" textAnchor="middle">leaf inserted ✓</text>

        <path className="flow-priv dash" d="M340,74 C420,18 600,18 690,76" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-faint" x="515" y="26" fontSize="8" textAnchor="middle">executeShieldImmediate · BOOTH_OPERATOR (bypass wait)</text>

        <path className="flow dash" d="M250,156 C250,196 270,206 300,210" markerEnd="url(#pd-arrow)" />
        <rect className="node-2" x="304" y="190" width="200" height="56" rx="13" />
        <text className="t-lab" x="404" y="214" fontSize="12" textAnchor="middle">Cancelled</text>
        <text className="t-tick t-faint" x="404" y="232" fontSize="8" textAnchor="middle">cancelShield · shielder</text>

        <path className="flow-pub dash" d="M340,156 C360,196 420,206 520,210" markerEnd="url(#pd-arrow-pub)" />
        <rect className="node-2" x="524" y="190" width="240" height="56" rx="13" />
        <text className="t-lab" x="644" y="214" fontSize="12" textAnchor="middle">Contested</text>
        <text className="t-tick t-faint" x="644" y="232" fontSize="8" textAnchor="middle">contestShield · VIGILANT_CITIZEN</text>
        <text className="t-tick t-faint" x="404" y="182" fontSize="8">refund escrow + cap</text>
      </svg>
    </div>
  );
}

/** 08 · The relayer breaks the gas link: gas sponsorship */
export function RelayerGasLink() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 392" role="img" aria-label="In self-broadcast, the user's own EVM address appears on the transfer event, linking them to the payment. With a relayer, the user produces the proof and payload client-side and hands them to a pool of five EOAs; the relayer's address appears on-chain instead, so the user's address never touches the event.">
        <line className="hair dash" x1="478" y1="40" x2="478" y2="360" />

        <text className="t-tick t-warn" x="24" y="34" fontSize="9.5">(a) Self-broadcast</text>
        <text className="t-tick t-faint" x="196" y="34" fontSize="8.5">you pay your own gas</text>

        <rect className="node" x="118" y="62" width="220" height="54" rx="12" />
        <text className="t-tick t-faint" x="134" y="84" fontSize="8.5">your wallet</text>
        <text className="t-mono" x="134" y="104" fontSize="12">EVM 0x9a3…f1</text>

        <path className="flow" d="M228,116 V172" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-faint" x="238" y="148" fontSize="8">broadcasts transfer()</text>

        <rect className="node" x="74" y="176" width="320" height="78" rx="13" />
        <text className="t-tick" x="92" y="200" fontSize="9">Contract · transfer event</text>
        <text className="t-lab" x="92" y="224" fontSize="12">from = <tspan className="t-mono t-warn">0x9a3…f1</tspan></text>
        <text className="t-tick t-faint" x="92" y="242" fontSize="8">public · anyone can read it</text>

        <path className="flow-pub dash" d="M344,96 C396,128 396,196 350,222" fill="none" />
        <g transform="translate(392,158)">
          <circle r="13" fill="var(--d-warn-soft)" stroke="var(--d-warn)" strokeWidth="1.5" />
          <path d="M0,-6 V1 M0,5 V5.5" stroke="var(--d-warn)" strokeWidth="2" strokeLinecap="round" />
        </g>
        <text className="t-tick t-warn" x="392" y="190" fontSize="8" textAnchor="middle">linked!</text>
        <text className="t-sub t-warn" x="234" y="296" fontSize="11" textAnchor="middle">your address ⟷ the payment</text>

        <text className="t-tick t-priv" x="504" y="34" fontSize="9.5">(b) Relayer · gas sponsor</text>
        <text className="t-tick t-faint" x="712" y="34" fontSize="8.5">your address stays off-chain</text>

        <rect x="508" y="56" width="184" height="170" rx="14" fill="none" stroke="var(--d-priv-line)" strokeWidth="1.4" strokeDasharray="5 4" />
        <text className="t-tick t-priv" x="520" y="74" fontSize="8">client-side · private</text>
        <rect className="node-2" x="520" y="82" width="160" height="32" rx="8" />
        <text className="t-mono" x="534" y="103" fontSize="11">You · wallet</text>
        <rect className="node-priv" x="520" y="122" width="160" height="32" rx="8" />
        <text className="t-mono t-priv" x="534" y="143" fontSize="10.5">proof + payload</text>
        <rect x="520" y="162" width="160" height="34" rx="8" fill="none" stroke="var(--d-line)" strokeWidth="1.2" strokeDasharray="4 3" />
        <text className="t-mono t-faint" x="534" y="178" fontSize="10">EVM 0x9a3…f1</text>
        <text className="t-tick t-faint" x="534" y="190" fontSize="7">stays here</text>

        <path className="flow-priv" d="M692,138 H716" markerEnd="url(#pd-arrow-priv)" />
        <rect className="node" x="718" y="92" width="208" height="96" rx="13" />
        <text className="t-tick" x="734" y="114" fontSize="9">Relayer pool</text>
        <text className="t-tick t-faint" x="734" y="128" fontSize="7.5">5 EOAs · LRU pick · only pays gas</text>
        <g>
          <rect x="734" y="142" width="28" height="26" rx="5" className="node-2" />
          <rect x="770" y="142" width="28" height="26" rx="5" className="node-priv" />
          <rect x="806" y="142" width="28" height="26" rx="5" className="node-2" />
          <rect x="842" y="142" width="28" height="26" rx="5" className="node-2" />
          <rect x="878" y="142" width="28" height="26" rx="5" className="node-2" />
          <text className="t-tick t-priv" x="784" y="182" fontSize="7" textAnchor="middle">LRU</text>
        </g>

        <path className="flow-priv" d="M820,188 C820,220 760,232 716,244" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-faint" x="828" y="214" fontSize="8">broadcasts transfer()</text>

        <rect className="node" x="560" y="248" width="360" height="78" rx="13" />
        <text className="t-tick" x="578" y="272" fontSize="9">Contract · transfer event</text>
        <text className="t-lab" x="578" y="296" fontSize="12">from = <tspan className="t-mono t-priv">0xRel…7c</tspan></text>
        <text className="t-tick t-faint" x="578" y="314" fontSize="8">the relayer's address, not yours</text>

        <path className="flow dash" d="M600,196 C560,220 560,236 600,248" fill="none" opacity="0.5" />
        <g transform="translate(566,224)">
          <circle r="10" fill="var(--d-surface)" stroke="var(--d-ink-mute)" strokeWidth="1.3" />
          <path d="M-3.6,-3.6 L3.6,3.6 M3.6,-3.6 L-3.6,3.6" stroke="var(--d-ink-mute)" strokeWidth="1.6" strokeLinecap="round" />
        </g>
        <text className="t-tick t-faint" x="566" y="208" fontSize="7.5" textAnchor="middle">never</text>

        <text className="t-sub t-priv" x="743" y="352" fontSize="10.5" textAnchor="middle">relayer can't read notes · can't alter the transfer</text>
      </svg>
    </div>
  );
}

/** 09 · The full journey: end-to-end swimlane */
export function FullJourney() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 392" role="img" aria-label="A three-lane swimlane (client wallet, Pampalo contract and tree, public chain) across three steps: shield, transfer, unshield. Alice shields USDC into a note, transfers part to Bob via a relayer, and Bob later unshields to a public address.">
        <rect x="112" y="60" width="824" height="84" rx="12" fill="var(--d-priv-soft)" opacity="0.55" />
        <rect x="112" y="152" width="824" height="84" rx="12" fill="var(--d-surface-2)" opacity="0.6" />
        <rect x="112" y="244" width="824" height="84" rx="12" fill="var(--d-pub-soft)" opacity="0.5" />

        <text className="t-tick t-priv" x="24" y="98" fontSize="9">CLIENT</text>
        <text className="t-tick t-faint" x="24" y="110" fontSize="7.5">wallet</text>
        <text className="t-tick" x="24" y="190" fontSize="9">PAMPALO</text>
        <text className="t-tick t-faint" x="24" y="202" fontSize="7.5">contract · tree</text>
        <text className="t-tick t-pub" x="24" y="282" fontSize="9">PUBLIC</text>
        <text className="t-tick t-faint" x="24" y="294" fontSize="7.5">chain</text>

        <line className="hair dash" x1="386" y1="50" x2="386" y2="338" />
        <line className="hair dash" x1="660" y1="50" x2="660" y2="338" />
        <text className="t-tick" x="130" y="44" fontSize="9.5">1 · Shield <tspan className="t-faint">public → private</tspan></text>
        <text className="t-tick" x="404" y="44" fontSize="9.5">2 · Transfer <tspan className="t-faint">private → private</tspan></text>
        <text className="t-tick" x="678" y="44" fontSize="9.5">3 · Unshield <tspan className="t-faint">private → public</tspan></text>

        <rect className="node-pub" x="128" y="256" width="234" height="60" rx="11" />
        <text className="t-lab" x="144" y="280" fontSize="11">approve + shield USDC</text>
        <text className="t-tick t-faint" x="144" y="298" fontSize="8">escrowed · monthly cap</text>

        <rect className="node" x="128" y="164" width="234" height="60" rx="11" />
        <text className="t-lab" x="144" y="188" fontSize="11">1h wait → executeShield</text>
        <text className="t-tick t-priv" x="144" y="206" fontSize="8">leaf inserted · Note A · 5 USDC</text>

        <rect className="node-priv" x="128" y="72" width="234" height="60" rx="11" />
        <text className="t-lab" x="144" y="96" fontSize="11">decrypt &amp; file Note A</text>
        <text className="t-tick t-faint" x="144" y="114" fontSize="8">stored locally · IndexedDB</text>

        <path className="flow" d="M245,256 V224" markerEnd="url(#pd-arrow)" />
        <path className="flow-priv" d="M245,164 V132" markerEnd="url(#pd-arrow-priv)" />

        <rect className="node-priv" x="402" y="72" width="242" height="60" rx="11" />
        <text className="t-lab" x="418" y="96" fontSize="11">build B (2→Bob) + C (3)</text>
        <text className="t-tick t-faint" x="418" y="114" fontSize="8">prove transfer · encrypt secrets</text>

        <rect className="node" x="402" y="164" width="242" height="60" rx="11" />
        <text className="t-lab" x="418" y="188" fontSize="11">verify · nullify A · insert B,C</text>
        <text className="t-tick t-faint" x="418" y="206" fontSize="8">emit NotePayload for each</text>

        <path className="flow-priv" d="M500,132 V164" markerEnd="url(#pd-arrow-priv)" />
        <g transform="translate(556,148)"><rect x="-44" y="-9" width="88" height="18" rx="9" className="node-2" /><text className="t-tick t-priv" x="0" y="3.5" fontSize="7.5" textAnchor="middle">via relayer</text></g>

        <path className="flow-priv dash" d="M600,164 V132" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-priv" x="612" y="152" fontSize="7.5">Bob decrypts B ✓</text>

        <rect className="node-priv" x="676" y="72" width="244" height="60" rx="11" />
        <text className="t-lab" x="692" y="96" fontSize="11">Bob proves withdraw</text>
        <text className="t-tick t-faint" x="692" y="114" fontSize="8">spend Note B</text>

        <rect className="node" x="676" y="164" width="244" height="60" rx="11" />
        <text className="t-lab" x="692" y="188" fontSize="11">verify · pay out</text>
        <text className="t-tick t-faint" x="692" y="206" fontSize="8">exit address front-run safe</text>

        <rect className="node-pub" x="676" y="256" width="244" height="60" rx="11" />
        <text className="t-lab" x="692" y="280" fontSize="11">USDC → any EVM address</text>
        <text className="t-tick t-faint" x="692" y="298" fontSize="8">monthly cap applies</text>

        <path className="flow-priv" d="M798,132 V164" markerEnd="url(#pd-arrow-priv)" />
        <path className="flow-pub" d="M798,224 V256" markerEnd="url(#pd-arrow-pub)" />

        <path className="flow-priv dash" d="M362,102 H402" markerEnd="url(#pd-arrow-priv)" opacity="0.7" />
        <path className="flow-priv dash" d="M644,102 H676" markerEnd="url(#pd-arrow-priv)" opacity="0.7" />

        <text className="t-sub" x="480" y="362" fontSize="11" textAnchor="middle">No server ever sees a plaintext note, a secret, or the link between Alice's and Bob's addresses.</text>
      </svg>
    </div>
  );
}

/* ==========================================================================
   Private-swap diagrams
   --------------------------------------------------------------------------
   Seven self-contained inline-SVG figures for the "Private Swaps" page,
   sharing the same theme system as the protocol diagrams above. Two rails:
   PRIVATE (calm green/teal) and PUBLIC (warm amber/orange), with a sparing
   REVERT red (.t-dang / .node-dang / .flow-dang) for the all-or-nothing
   failure path. Render <PampaloDefs /> once near the top of the page.
   ========================================================================== */

/** PS·01 · The big picture: private notes in, public trade, private note out */
export function PrivateSwapBigPicture() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 430" role="img" aria-label="A private note of token A is spent and retired into a private swap, which trades against public Uniswap v4 or v3 liquidity and mints a fresh private note of token B. The note ends stay on the cool private rail; only the trade dips down to the warm public rail.">
        {/* rail bands */}
        <rect x="20" y="78" width="920" height="146" rx="16" fill="var(--d-priv-soft)" opacity="0.5" />
        <rect x="296" y="288" width="368" height="112" rx="16" fill="var(--d-pub-soft)" opacity="0.55" />
        <text className="t-tick t-priv" x="40" y="70" fontSize="9.5">Pampalo.sol · privateSwap()</text>
        <text className="t-tick t-pub" x="312" y="282" fontSize="9.5">Public rail · Uniswap AMM</text>

        {/* Note A (frosted) */}
        <g>
          <path className="node-priv" d="M44,90 H220 a8,8 0 0 1 8,8 V202 a8,8 0 0 1 -8,8 H52 a8,8 0 0 1 -8,-8 V90 Z" />
          <path d="M206,90 H228 V112 Z" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.2" />
          <g className="frost"><line x1="56" y1="150" x2="216" y2="150" /><line x1="56" y1="168" x2="216" y2="168" /></g>
          <text className="t-tick t-priv" x="62" y="116" fontSize="10">Private note</text>
          <text className="t-mono" x="62" y="146" fontSize="22" fontWeight="600">Token A</text>
          <rect x="62" y="176" width="120" height="20" rx="6" fill="var(--d-priv-line)" opacity="0.5" />
          <text className="t-tick" x="68" y="190" fontSize="8.5" fill="var(--d-surface)">owner hidden</text>
        </g>

        {/* Private swap hexagon */}
        <polygon className="node-2" points="404,150 442,92 518,92 556,150 518,208 442,208" />
        <text className="t-title" x="480" y="146" fontSize="16" textAnchor="middle">Private swap</text>
        <text className="t-tick" x="480" y="168" fontSize="8.5" textAnchor="middle">one atomic tx</text>

        {/* Note B (frosted) */}
        <g>
          <path className="node-priv" d="M720,90 H896 a8,8 0 0 1 8,8 V202 a8,8 0 0 1 -8,8 H728 a8,8 0 0 1 -8,-8 V90 Z" />
          <path d="M882,90 H904 V112 Z" fill="var(--d-surface)" stroke="var(--d-priv-line)" strokeWidth="1.2" />
          <g className="frost"><line x1="732" y1="150" x2="892" y2="150" /><line x1="732" y1="168" x2="892" y2="168" /></g>
          <text className="t-tick t-priv" x="738" y="116" fontSize="10">Private note</text>
          <text className="t-mono" x="738" y="146" fontSize="22" fontWeight="600">Token B</text>
          <rect x="738" y="176" width="120" height="20" rx="6" fill="var(--d-priv-line)" opacity="0.5" />
          <text className="t-tick" x="744" y="190" fontSize="8.5" fill="var(--d-surface)">owner hidden</text>
        </g>

        {/* Uniswap cylinder */}
        <g>
          <path d="M400,306 V370 A80,14 0 0 0 560,370 V306" className="node-pub" />
          <ellipse cx="480" cy="306" rx="80" ry="14" className="node-pub" />
          <text className="t-mono t-pub" x="480" y="346" fontSize="13" textAnchor="middle" fontWeight="600">Uniswap v4 / v3</text>
          <text className="t-tick t-pub" x="480" y="364" fontSize="8" textAnchor="middle">public liquidity</text>
        </g>

        {/* flows */}
        <path className="flow-priv m-flow" d="M236,150 H404" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-priv" x="320" y="138" fontSize="8.5" textAnchor="middle">spend &amp; retire</text>
        <circle className="m-token ps-tA" r="5" fill="var(--d-priv)" />
        <path className="flow-priv m-flow" d="M556,150 H720" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-priv" x="638" y="138" fontSize="8.5" textAnchor="middle">mint new note · T</text>
        <circle className="m-token ps-tB" r="5" fill="var(--d-priv)" />
        <path className="flow-pub m-flow" d="M462,208 V300" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-pub" x="396" y="258" fontSize="8" textAnchor="middle">trade A→B</text>
        <circle className="m-token ps-down" r="5" fill="var(--d-pub)" />
        <path className="flow-pub m-flow" d="M500,300 V216" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-pub" x="566" y="258" fontSize="8" textAnchor="middle">tokens back</text>
        <circle className="m-token ps-up" r="5" fill="var(--d-pub)" />

        <text className="t-sub" x="480" y="416" fontSize="11.5" textAnchor="middle">No separate private pool — the trade executes against the same public liquidity everyone else uses.</text>
      </svg>
    </div>
  );
}

/** PS·02 · We hide who, not how much: the honesty split */
export function HideWhoNotHowMuch() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 420" role="img" aria-label="A one-way mirror down the middle. On the private green side, three facts are hidden: who owns the input note, who owns the output note, and the link between your note and this swap. On the public amber side, three facts are visible: which tokens were traded, the amount swapped, and that a private swap happened. You can read the number through the glass, but not the face behind it.">
        <g transform="translate(40,44)">
          <circle cx="8" cy="-4" r="6" className="node-priv" />
          <text className="t-tick t-priv" x="24" y="0" fontSize="10.5">Private · hidden on-chain</text>
        </g>
        <g transform="translate(560,44)">
          <circle cx="8" cy="-4" r="6" className="node-pub" />
          <text className="t-tick t-pub" x="24" y="0" fontSize="10.5">Public · visible on-chain</text>
        </g>

        {/* one-way mirror band */}
        <rect x="452" y="64" width="56" height="300" rx="10" fill="var(--d-surface-2)" stroke="var(--d-line-hi)" strokeWidth="1.5" />
        <g className="frost" opacity="0.5">
          <line x1="458" y1="76" x2="502" y2="120" /><line x1="458" y1="116" x2="502" y2="160" />
          <line x1="458" y1="156" x2="502" y2="200" /><line x1="458" y1="196" x2="502" y2="240" />
          <line x1="458" y1="236" x2="502" y2="280" /><line x1="458" y1="276" x2="502" y2="320" />
          <line x1="458" y1="316" x2="502" y2="360" />
        </g>
        <text className="t-tick t-faint" x="480" y="384" fontSize="8" textAnchor="middle">one-way mirror</text>

        {/* PRIVATE rows */}
        <g fontSize="12">
          <rect className="node-priv" x="40" y="76" width="392" height="76" rx="13" />
          <g transform="translate(70,114)">
            <circle r="15" fill="var(--d-priv-line)" opacity="0.35" />
            <path d="M-9,0 H9" stroke="var(--d-priv)" strokeWidth="2.4" strokeLinecap="round" />
          </g>
          <text className="t-lab" x="104" y="110">Who owns the input note</text>
          <text className="t-tick t-priv" x="104" y="130" fontSize="8">the spender stays anonymous</text>
          <rect className="node-priv" x="40" y="164" width="392" height="76" rx="13" />
          <g transform="translate(70,202)">
            <circle r="15" fill="var(--d-priv-line)" opacity="0.35" />
            <path d="M-9,0 H9" stroke="var(--d-priv)" strokeWidth="2.4" strokeLinecap="round" />
          </g>
          <text className="t-lab" x="104" y="198">Who owns the output note</text>
          <text className="t-tick t-priv" x="104" y="218" fontSize="8">recipient identity hidden</text>
          <rect className="node-priv" x="40" y="252" width="392" height="76" rx="13" />
          <g transform="translate(70,290)">
            <circle r="15" fill="var(--d-priv-line)" opacity="0.35" />
            <path d="M-7,-6 L7,6 M-7,6 L7,-6" stroke="var(--d-priv)" strokeWidth="2.2" strokeLinecap="round" />
          </g>
          <text className="t-lab" x="104" y="286">The link between your note</text>
          <text className="t-lab" x="104" y="304">and this swap</text>
          <text className="t-tick t-priv" x="104" y="322" fontSize="8">unlinkable to your wallet</text>
        </g>

        {/* PUBLIC rows */}
        <g fontSize="12">
          <rect className="node-pub" x="528" y="76" width="392" height="76" rx="13" />
          <g transform="translate(558,114)"><circle r="15" fill="none" stroke="var(--d-pub)" strokeWidth="1.6" /><circle r="5" fill="var(--d-pub)" /><path d="M-15,0 a15,11 0 0 0 30,0 a15,11 0 0 0 -30,0" fill="none" stroke="var(--d-pub)" strokeWidth="1.4" /></g>
          <text className="t-lab" x="592" y="110">Which tokens were traded</text>
          <text className="t-mono t-pub" x="592" y="130" fontSize="11">Token A → Token B</text>
          <rect className="node-pub" x="528" y="164" width="392" height="76" rx="13" />
          <g transform="translate(558,202)"><circle r="15" fill="none" stroke="var(--d-pub)" strokeWidth="1.6" /><circle r="5" fill="var(--d-pub)" /><path d="M-15,0 a15,11 0 0 0 30,0 a15,11 0 0 0 -30,0" fill="none" stroke="var(--d-pub)" strokeWidth="1.4" /></g>
          <text className="t-lab" x="592" y="198">The amount swapped</text>
          <text className="t-mono t-pub" x="592" y="218" fontSize="11">readable through the glass</text>
          <rect className="node-pub" x="528" y="252" width="392" height="76" rx="13" />
          <g transform="translate(558,290)"><circle r="15" fill="none" stroke="var(--d-pub)" strokeWidth="1.6" /><circle r="5" fill="var(--d-pub)" /><path d="M-15,0 a15,11 0 0 0 30,0 a15,11 0 0 0 -30,0" fill="none" stroke="var(--d-pub)" strokeWidth="1.4" /></g>
          <text className="t-lab" x="592" y="286">That a private swap happened</text>
          <text className="t-tick t-pub" x="592" y="306" fontSize="8">the event is on the public chain</text>
        </g>

        <text className="t-sub" x="480" y="402" fontSize="12.5" textAnchor="middle"><tspan className="t-priv" fontWeight="600">We hide who, not how much.</tspan> Against a public market, the amount has to be public — so we hide everything else.</text>
      </svg>
    </div>
  );
}

/** PS·03 · Four steps, one atomic transaction */
export function FourStepsAtomic() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 440" role="img" aria-label="Inside one privateSwap call paid by a relayer: Prove builds a zero-knowledge proof; Verify checks the root and proof and retires the input note; Swap trades the pooled balance on public Uniswap; Mint creates the new private note worth exactly the target T, leaving the surplus in reserves. Any failed check — unknown root, bad proof, or a realized amount below T — drops into a single revert rail and the whole transaction reverts.">
        <rect className="node-2" x="20" y="34" width="262" height="30" rx="8" />
        <text className="t-mono" x="36" y="54" fontSize="10.5">privateSwap()</text>
        <text className="t-tick t-faint" x="266" y="54" fontSize="8" textAnchor="end">relayer pays gas</text>
        <path className="flow" d="M150,64 V84" markerEnd="url(#pd-arrow)" />

        {/* BEAT 1 · Prove */}
        <rect className="node-priv" x="20" y="90" width="210" height="150" rx="14" />
        <text className="t-tick t-priv" x="40" y="116" fontSize="9">Step 1 · client</text>
        <text className="t-title" x="40" y="142" fontSize="18">Prove</text>
        <text className="t-sub" x="40" y="168" fontSize="10.5">Build a zero-knowledge</text>
        <text className="t-sub" x="40" y="184" fontSize="10.5">proof that you own a note —</text>
        <text className="t-sub" x="40" y="200" fontSize="10.5">without revealing which one.</text>
        <g transform="translate(40,214)"><rect x="0" y="0" width="13" height="11" rx="2" fill="none" stroke="var(--d-priv)" strokeWidth="1.4" /><path d="M2.5,0 V-1.6 a4,4 0 0 1 8,0 V0" fill="none" stroke="var(--d-priv)" strokeWidth="1.4" /></g>
        <text className="t-tick t-priv" x="60" y="223" fontSize="8">sealed witnesses</text>

        {/* BEAT 2 · Verify */}
        <rect className="node" x="262" y="90" width="210" height="150" rx="14" />
        <text className="t-tick t-faint" x="282" y="116" fontSize="9">Step 2 · contract</text>
        <text className="t-title" x="282" y="142" fontSize="18">Verify</text>
        <g fontSize="10">
          <g transform="translate(290,160)"><circle r="7" className="node-priv" /><path d="M-3.2,0 l2.3,2.5 l4,-4.8" fill="none" stroke="var(--d-priv)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></g>
          <text className="t-lab" x="306" y="164" fontSize="10.5">root recognised</text>
          <g transform="translate(290,184)"><circle r="7" className="node-priv" /><path d="M-3.2,0 l2.3,2.5 l4,-4.8" fill="none" stroke="var(--d-priv)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></g>
          <text className="t-lab" x="306" y="188" fontSize="10.5">proof valid</text>
          <g transform="translate(290,208)"><circle r="7" className="node-priv" /><path d="M-3.2,0 l2.3,2.5 l4,-4.8" fill="none" stroke="var(--d-priv)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></g>
          <text className="t-lab" x="306" y="212" fontSize="10.5">retire input note</text>
        </g>

        {/* BEAT 3 · Swap */}
        <rect className="node-pub" x="504" y="90" width="210" height="150" rx="14" />
        <text className="t-tick t-pub" x="524" y="116" fontSize="9">Step 3 · public market</text>
        <text className="t-title" x="524" y="142" fontSize="18">Swap</text>
        <text className="t-sub" x="524" y="168" fontSize="10.5">Trade your pooled balance</text>
        <text className="t-sub" x="524" y="184" fontSize="10.5">on Uniswap for Token B.</text>
        <g transform="translate(524,198)">
          <path d="M0,8 V30 A28,7 0 0 0 56,30 V8" className="node-pub" />
          <ellipse cx="28" cy="8" rx="28" ry="7" className="node-pub" />
          <text className="t-tick t-pub" x="28" y="24" fontSize="7.5" textAnchor="middle">v4 / v3</text>
        </g>
        <text className="t-tick t-pub" x="624" y="214" fontSize="8">realized</text>
        <text className="t-tick t-pub" x="624" y="226" fontSize="8">amount</text>

        {/* BEAT 4 · Mint */}
        <rect className="node-priv" x="746" y="90" width="194" height="150" rx="14" />
        <text className="t-tick t-priv" x="766" y="116" fontSize="9">Step 4 · client note</text>
        <text className="t-title" x="766" y="142" fontSize="18">Mint</text>
        <text className="t-sub" x="766" y="168" fontSize="10.5">Create your new private</text>
        <text className="t-sub" x="766" y="184" fontSize="10.5">note — worth exactly T.</text>
        <path className="node-priv" d="M766,196 H912 a6,6 0 0 1 6,6 V224 a6,6 0 0 1 -6,6 H766 Z" />
        <text className="t-mono t-priv" x="778" y="216" fontSize="10">Token B · note = T</text>

        {/* between-beat arrows */}
        <path className="flow-priv m-flow" d="M230,165 H262" markerEnd="url(#pd-arrow-priv)" />
        <path className="flow m-flow" d="M472,165 H504" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-faint" x="488" y="156" fontSize="7" textAnchor="middle">pooled A</text>

        {/* floor gate between Swap and Mint */}
        <g transform="translate(730,165)">
          <polygon points="0,-22 22,0 0,22 -22,0" className="node-2" />
          <text className="t-tick" x="0" y="-2" fontSize="7" textAnchor="middle">≥ T?</text>
          <text className="t-tick t-priv" x="0" y="9" fontSize="6.5" textAnchor="middle">floor</text>
        </g>
        <path className="flow-priv m-flow" d="M714,165 H708" markerStart="url(#pd-arrow-priv)" />
        <path className="flow-priv" d="M752,165 H746" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-priv" x="734" y="146" fontSize="7.5" textAnchor="middle">yes</text>

        {/* surplus to reserves */}
        <path className="flow m-flow" d="M843,230 V268" markerEnd="url(#pd-arrow)" />
        <rect className="node-2" x="746" y="270" width="194" height="40" rx="11" />
        <text className="t-lab" x="843" y="288" fontSize="10" textAnchor="middle">surplus above T</text>
        <text className="t-tick t-faint" x="843" y="302" fontSize="7.5" textAnchor="middle">stays in protocol reserves</text>

        {/* REVERT RAIL */}
        <rect x="20" y="356" width="694" height="58" rx="14" fill="var(--d-dang-soft)" stroke="var(--d-dang-line)" strokeWidth="1.5" strokeDasharray="6 5" />
        <g transform="translate(56,385)">
          <circle r="13" fill="none" stroke="var(--d-dang)" strokeWidth="1.6" />
          <path d="M-5,-5 L5,5 M5,-5 L-5,5" stroke="var(--d-dang)" strokeWidth="2" strokeLinecap="round" />
        </g>
        <text className="t-title t-dang" x="86" y="382" fontSize="15">revert</text>
        <text className="t-tick t-dang" x="86" y="400" fontSize="8.5">nothing happens · all-or-nothing</text>
        <text className="t-sub t-dang" x="500" y="390" fontSize="11" textAnchor="middle">any failed check unwinds the entire transaction</text>

        <path className="flow-dang dash" d="M367,240 V356" markerEnd="url(#pd-arrow-dang)" />
        <text className="t-tick t-dang" x="378" y="300" fontSize="7.5">unknown root · bad proof</text>
        <path className="flow-dang dash" d="M730,188 C730,300 640,310 600,356" markerEnd="url(#pd-arrow-dang)" />
        <text className="t-tick t-dang" x="700" y="280" fontSize="7.5" textAnchor="middle">realized &lt; T</text>
      </svg>
    </div>
  );
}

/** PS·04 · You set the floor. You always clear it. */
export function YouSetTheFloor() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 400" role="img" aria-label="A two-phase timeline. Before, off-chain, you pick a target T and your proof bakes in a new note worth exactly T of token B — the amount you will actually receive does not exist yet. During, on-chain, the swap returns a realized amount. If realized is at or above T, you mint a note worth exactly T and the surplus above it stays in reserves. If realized falls below T, the whole transaction reverts.">
        <text className="t-tick t-priv" x="24" y="40" fontSize="10">Before — you prove · off-chain</text>
        <text className="t-tick t-pub" x="512" y="40" fontSize="10">During — it executes · on-chain</text>
        <line className="hair dash" x1="478" y1="52" x2="478" y2="372" />

        {/* BEFORE */}
        <rect className="node" x="24" y="64" width="200" height="58" rx="12" />
        <text className="t-lab" x="124" y="90" fontSize="12" textAnchor="middle">pick target T</text>
        <text className="t-tick t-priv" x="124" y="108" fontSize="8" textAnchor="middle">your floor price</text>
        <path className="flow" d="M124,122 V150" markerEnd="url(#pd-arrow)" />
        <rect className="node-priv" x="24" y="154" width="200" height="76" rx="12" />
        <text className="t-sub" x="124" y="180" fontSize="10.5" textAnchor="middle">proof bakes in a new note</text>
        <text className="t-mono t-priv" x="124" y="200" fontSize="12" textAnchor="middle" fontWeight="600">worth exactly T</text>
        <text className="t-tick t-priv" x="124" y="218" fontSize="8" textAnchor="middle">of Token B</text>

        <text className="t-sub t-faint" x="124" y="266" fontSize="10" textAnchor="middle">the amount you'll receive</text>
        <text className="t-sub t-faint" x="124" y="282" fontSize="10" textAnchor="middle">doesn't exist yet …</text>
        <path className="flow dash" d="M224,200 C320,200 320,290 408,290" markerEnd="url(#pd-arrow)" />

        {/* DURING · the floor bar chart */}
        <g transform="translate(560,0)">
          <line className="tick" x1="0" y1="320" x2="320" y2="320" />
          <text className="t-tick t-faint" x="-4" y="324" fontSize="8" textAnchor="end">0</text>

          <rect x="40" y="120" width="92" height="200" rx="4" fill="var(--d-priv-soft)" stroke="var(--d-priv-line)" strokeWidth="1.5" />
          <rect x="40" y="120" width="92" height="64" rx="4" fill="var(--d-warn-soft)" stroke="var(--d-warn)" strokeWidth="1.3" />
          <text className="t-tick t-warn" x="86" y="158" fontSize="8" textAnchor="middle">surplus</text>
          <text className="t-mono t-priv" x="86" y="260" fontSize="13" textAnchor="middle" fontWeight="600">your note</text>
          <text className="t-tick t-priv" x="86" y="278" fontSize="8" textAnchor="middle">= exactly T</text>

          <line className="tick" x1="30" y1="120" x2="150" y2="120" stroke="var(--d-priv)" />
          <text className="t-tick t-priv" x="160" y="124" fontSize="8.5">realized</text>

          <line x1="20" y1="184" x2="200" y2="184" stroke="var(--d-warn)" strokeWidth="2" strokeDasharray="5 4" />
          <text className="t-mono t-warn" x="160" y="180" fontSize="11" fontWeight="600">floor T</text>

          <path className="flow" d="M132,150 H214" markerEnd="url(#pd-arrow)" />
          <text className="t-tick t-faint" x="220" y="146" fontSize="8">surplus (realized − T)</text>
          <text className="t-tick t-faint" x="220" y="160" fontSize="8">→ reserves</text>
        </g>

        <g transform="translate(512,344)">
          <g transform="translate(12,0)"><circle r="10" className="node-priv" /><path d="M-4.4,0 l3,3.2 l5.4,-6.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></g>
          <text className="t-sub t-priv" x="30" y="4" fontSize="11" fontWeight="600">realized ≥ T → you always clear your floor</text>
        </g>
        <g transform="translate(512,374)">
          <g transform="translate(12,-4)"><circle r="10" className="node-dang" /><path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="var(--d-dang)" strokeWidth="1.8" strokeLinecap="round" /></g>
          <text className="t-sub t-dang" x="30" y="0" fontSize="11">realized &lt; T → revert · nothing happens</text>
        </g>
      </svg>
    </div>
  );
}

/** PS·05 · One flow, any Uniswap: the venue fork */
export function OneFlowAnyUniswap() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 360" role="img" aria-label="The shared core — verify, retire, swap, mint — forks at the swap step to a venue choice. Uniswap v4 unlocks the PoolManager and swaps through its callback; Uniswap v3 approves the router and calls exactInput. Both return Token B and rejoin the shared core to check the floor and mint the note, routing to whichever pool is deeper.">
        <rect className="node" x="24" y="116" width="206" height="88" rx="14" />
        <text className="t-tick t-faint" x="40" y="140" fontSize="8.5">shared core</text>
        <text className="t-mono" x="40" y="162" fontSize="11">verify → retire</text>
        <text className="t-mono t-pub" x="40" y="182" fontSize="11">→ SWAP →</text>
        <text className="t-mono" x="40" y="200" fontSize="11" opacity="0.55">mint</text>

        <g transform="translate(300,160)">
          <polygon points="0,-30 30,0 0,30 -30,0" className="node-2" />
          <text className="t-tick" x="0" y="-2" fontSize="8.5" textAnchor="middle">which</text>
          <text className="t-tick" x="0" y="10" fontSize="8.5" textAnchor="middle">venue?</text>
        </g>
        <path className="flow-pub m-flow" d="M230,160 H270" markerEnd="url(#pd-arrow-pub)" />

        {/* v4 lane */}
        <path className="flow-pub" d="M330,142 C372,118 392,96 430,96" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-pub" x="372" y="104" fontSize="8">v4</text>
        <rect className="node-pub" x="432" y="64" width="244" height="64" rx="13" />
        <text className="t-mono t-pub" x="450" y="90" fontSize="11" fontWeight="600">Uniswap v4</text>
        <text className="t-sub" x="450" y="110" fontSize="10">unlock PoolManager · swap in callback</text>

        {/* v3 lane */}
        <path className="flow-pub" d="M330,178 C372,202 392,224 430,224" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-pub" x="372" y="222" fontSize="8">v3</text>
        <rect className="node-pub" x="432" y="192" width="244" height="64" rx="13" />
        <text className="t-mono t-pub" x="450" y="218" fontSize="11" fontWeight="600">Uniswap v3</text>
        <text className="t-sub" x="450" y="238" fontSize="10">approve router · call exactInput</text>

        {/* converge → received */}
        <path className="flow-pub" d="M676,96 C720,96 728,150 754,158" markerEnd="url(#pd-arrow-pub)" />
        <path className="flow-pub" d="M676,224 C720,224 728,170 754,162" markerEnd="url(#pd-arrow-pub)" />
        <rect className="node" x="756" y="132" width="180" height="56" rx="13" />
        <text className="t-lab" x="846" y="156" fontSize="11" textAnchor="middle">received Token B</text>
        <text className="t-tick t-faint" x="846" y="174" fontSize="8" textAnchor="middle">back to shared core</text>

        <text className="t-tick t-priv" x="846" y="206" fontSize="8.5" textAnchor="middle">routes to whichever pool is deeper</text>

        <path className="flow m-flow" d="M846,188 C846,312 360,312 130,312 V210" markerEnd="url(#pd-arrow)" />
        <text className="t-sub" x="468" y="308" fontSize="10.5" textAnchor="middle">… rejoin shared core → check floor T → mint note</text>
      </svg>
    </div>
  );
}

/** PS·06 · What keeps it safe: three guarantees */
export function WhatKeepsItSafe() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 290" role="img" aria-label="Three safety guarantees. Nullifier: spending retires the input note so it can't be double-spent, and breaks the trail back to you. Bindings: the proof binds the input token, output token and floor T, so a relayer can pick a bad route but can never steal or redirect your funds. Atomicity: it is all-or-nothing — any failure reverts the whole transaction.">
        {/* card 1 · nullifier */}
        <g>
          <rect className="node" x="20" y="40" width="296" height="220" rx="16" />
          <text className="t-tick t-priv" x="44" y="70" fontSize="9">01 · double-spend defence</text>
          <g transform="translate(44,86)">
            <rect className="node-priv" x="0" y="0" width="60" height="44" rx="8" />
            <path d="M8,40 L52,4" stroke="var(--d-priv)" strokeWidth="2.4" strokeLinecap="round" />
          </g>
          <text className="t-title" x="44" y="160" fontSize="17">Nullifier</text>
          <text className="t-sub" x="44" y="186" fontSize="11">Spending publishes a one-way</text>
          <text className="t-sub" x="44" y="204" fontSize="11">fingerprint that retires the note.</text>
          <text className="t-sub" x="44" y="222" fontSize="11">It can't be reused — and the</text>
          <text className="t-sub" x="44" y="240" fontSize="11">fingerprint breaks the trail to you.</text>
        </g>

        {/* card 2 · bindings */}
        <g>
          <rect className="node" x="332" y="40" width="296" height="220" rx="16" />
          <text className="t-tick t-warn" x="356" y="70" fontSize="9">02 · the relayer's ceiling</text>
          <g transform="translate(356,84)">
            <rect x="18" y="14" width="30" height="24" rx="5" fill="var(--d-surface)" stroke="var(--d-warn)" strokeWidth="1.8" />
            <path d="M23,14 V9 a10,10 0 0 1 20,0 V14" fill="none" stroke="var(--d-warn)" strokeWidth="1.8" />
            <circle cx="33" cy="26" r="3" fill="var(--d-warn)" />
            <rect className="node-2" x="0" y="46" width="20" height="12" rx="3" />
            <rect className="node-2" x="23" y="46" width="20" height="12" rx="3" />
            <rect className="node-2" x="46" y="46" width="20" height="12" rx="3" />
          </g>
          <text className="t-title" x="356" y="172" fontSize="17">Bindings</text>
          <text className="t-sub" x="356" y="198" fontSize="11">The proof binds input token,</text>
          <text className="t-sub" x="356" y="216" fontSize="11">output token and the floor T.</text>
          <text className="t-sub" x="356" y="234" fontSize="11">Worst a relayer can do is pick a</text>
          <text className="t-sub" x="356" y="252" fontSize="11">bad route — never steal or redirect.</text>
        </g>

        {/* card 3 · atomicity */}
        <g>
          <rect className="node" x="644" y="40" width="296" height="220" rx="16" />
          <text className="t-tick t-dang" x="668" y="70" fontSize="9">03 · all-or-nothing</text>
          <g transform="translate(668,84)">
            <rect className="node-2" x="0" y="0" width="56" height="44" rx="8" />
            <text className="t-mono" x="28" y="27" fontSize="9" textAnchor="middle">1 tx</text>
            <g transform="translate(74,8)"><circle r="9" className="node-priv" /><path d="M-3.8,0 l2.6,2.8 l4.6,-5.4" fill="none" stroke="var(--d-priv)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></g>
            <g transform="translate(74,34)"><circle r="9" className="node-dang" /><path d="M-3.6,-3.6 L3.6,3.6 M3.6,-3.6 L-3.6,3.6" stroke="var(--d-dang)" strokeWidth="1.8" strokeLinecap="round" /></g>
          </g>
          <text className="t-title" x="668" y="172" fontSize="17">Atomicity</text>
          <text className="t-sub" x="668" y="198" fontSize="11">It fully works or fully reverts.</text>
          <text className="t-sub" x="668" y="216" fontSize="11">Any failure — including missing</text>
          <text className="t-sub" x="668" y="234" fontSize="11">the floor — unwinds everything.</text>
          <text className="t-sub" x="668" y="252" fontSize="11">No partial state, ever.</text>
        </g>
      </svg>
    </div>
  );
}

/** PS·07 · End-to-end, who does what: the sequence */
export function PrivateSwapSequence() {
  return (
    <div className="pampdia">
      <svg viewBox="0 0 960 540" role="img" aria-label="A sequence across five actors: you and your wallet, the relayer, the Pampalo contract, the proof verifier, and Uniswap. You pick a note, target and route and build a zero-knowledge proof, then hand the proof — not your identity — to the relayer. The relayer submits privateSwap and pays gas. The contract checks the proof with the verifier, retires the input note, swaps pooled A for B on Uniswap, then requires the realized amount to clear T, mints the B note and keeps the surplus. Success returns to the relayer; later you find and spend the new private note.">
        {/* actor columns */}
        <g fontSize="10">
          <rect className="node-priv" x="24" y="34" width="150" height="44" rx="11" /><text className="t-lab t-priv" x="99" y="54" fontSize="11" textAnchor="middle">You · wallet</text><text className="t-tick t-faint" x="99" y="70" fontSize="7.5" textAnchor="middle">private</text>
          <rect className="node" x="214" y="34" width="150" height="44" rx="11" /><text className="t-lab" x="289" y="54" fontSize="11" textAnchor="middle">Relayer</text><text className="t-tick t-faint" x="289" y="70" fontSize="7.5" textAnchor="middle">pays gas</text>
          <rect className="node" x="404" y="34" width="150" height="44" rx="11" /><text className="t-lab" x="479" y="54" fontSize="11" textAnchor="middle">Pampalo</text><text className="t-tick t-faint" x="479" y="70" fontSize="7.5" textAnchor="middle">contract</text>
          <rect className="node" x="594" y="34" width="150" height="44" rx="11" /><text className="t-lab" x="669" y="54" fontSize="11" textAnchor="middle">Proof verifier</text><text className="t-tick t-faint" x="669" y="70" fontSize="7.5" textAnchor="middle">zk</text>
          <rect className="node-pub" x="784" y="34" width="152" height="44" rx="11" /><text className="t-lab t-pub" x="860" y="54" fontSize="11" textAnchor="middle">Uniswap</text><text className="t-tick t-faint" x="860" y="70" fontSize="7.5" textAnchor="middle">v4 / v3</text>
        </g>
        {/* lifelines */}
        <g className="hair">
          <line x1="99" y1="78" x2="99" y2="500" />
          <line x1="289" y1="78" x2="289" y2="500" />
          <line x1="479" y1="78" x2="479" y2="500" />
          <line x1="669" y1="78" x2="669" y2="500" />
          <line x1="860" y1="78" x2="860" y2="500" />
        </g>

        {/* self-action: pick + prove (on You) */}
        <rect className="node-priv" x="68" y="98" width="62" height="50" rx="8" />
        <g fontSize="9">
          <text className="t-tick t-faint" x="14" y="116" fontSize="8">1</text>
          <text className="t-sub" x="138" y="116" fontSize="10">pick note + target T + route</text>
          <text className="t-tick t-faint" x="14" y="140" fontSize="8">2</text>
          <text className="t-sub" x="138" y="140" fontSize="10">build zero-knowledge proof</text>
        </g>

        {/* 3 You → Relayer */}
        <path className="flow-priv" d="M130,170 H289" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-faint" x="14" y="166" fontSize="8">3</text>
        <text className="t-sub" x="138" y="164" fontSize="10">hand over proof — not your identity</text>

        {/* 4 Relayer → Contract */}
        <path className="flow" d="M289,202 H479" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-faint" x="200" y="198" fontSize="8">4</text>
        <text className="t-sub" x="300" y="196" fontSize="10">submit privateSwap() · pays gas</text>

        {/* 5 Contract → Verifier */}
        <path className="flow" d="M479 234 H669" markerEnd="url(#pd-arrow)" />
        <text className="t-tick t-faint" x="390" y="230" fontSize="8">5</text>
        <text className="t-sub" x="500" y="228" fontSize="10">check proof</text>

        {/* 6 Verifier → Contract (valid) */}
        <path className="flow-priv dash" d="M669,264 H479" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-faint" x="390" y="260" fontSize="8">6</text>
        <text className="t-tick t-priv" x="500" y="258" fontSize="9">valid ✓</text>

        {/* 7 Contract self: retire note */}
        <rect className="node" x="448" y="280" width="62" height="34" rx="8" />
        <text className="t-tick t-faint" x="390" y="298" fontSize="8">7</text>
        <text className="t-sub" x="520" y="300" fontSize="10">retire input note</text>

        {/* 8 Contract → Uniswap */}
        <path className="flow-pub" d="M479,336 H860" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-faint" x="390" y="332" fontSize="8">8</text>
        <text className="t-sub t-pub" x="560" y="330" fontSize="10">swap pooled A → B</text>

        {/* 9 Uniswap → Contract */}
        <path className="flow-pub dash" d="M860,366 H479" markerEnd="url(#pd-arrow-pub)" />
        <text className="t-tick t-faint" x="390" y="362" fontSize="8">9</text>
        <text className="t-tick t-pub" x="560" y="360" fontSize="9">realized B</text>

        {/* 10 Contract self: require ≥T, mint, keep surplus */}
        <rect className="node-priv" x="440" y="382" width="78" height="50" rx="8" />
        <text className="t-tick t-faint" x="390" y="400" fontSize="8">10</text>
        <text className="t-sub" x="528" y="400" fontSize="10">require realized ≥ T</text>
        <text className="t-sub t-priv" x="528" y="416" fontSize="10">mint B note · keep surplus</text>

        {/* 11 Contract → Relayer success */}
        <path className="flow-priv dash" d="M479,452 H289" markerEnd="url(#pd-arrow-priv)" />
        <text className="t-tick t-faint" x="200" y="448" fontSize="8">11</text>
        <text className="t-tick t-priv" x="300" y="446" fontSize="9">success</text>

        {/* 12 You self later */}
        <rect className="node-priv" x="68" y="468" width="62" height="34" rx="8" />
        <text className="t-tick t-faint" x="14" y="486" fontSize="8">12</text>
        <text className="t-sub" x="138" y="488" fontSize="10">later · find &amp; spend the new private note</text>

        {/* privacy boundary annotation */}
        <line className="hair dash" x1="190" y1="86" x2="190" y2="500" />
        <text className="t-tick t-priv" x="180" y="516" fontSize="8" textAnchor="end">your identity stays</text>
        <text className="t-tick t-priv" x="180" y="528" fontSize="8" textAnchor="end">left of this line</text>
      </svg>
    </div>
  );
}
