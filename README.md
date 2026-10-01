# game-hub-server

Orchestrateur de session du portfolio [mathyslan.github.io](https://mathyslan.github.io).
Un salon (un groupe d'amis, leurs identités, leur hôte) et **le tirage du jeu**
pour ce groupe. Rien d'autre.

```
PROFIL / JOUEURS  →  SESSION  →  SÉLECTION (tirage)  →  (plus tard) HANDOFF  →  SERVEUR DE JEU
                     ▲────── ce dépôt ──────▲                                    ▲ les 7 existants
```

## Ce que le Hub ne fait pas — et ne doit jamais faire

Il ne connaît **aucune règle**, **aucun score de partie**, **aucun secret**,
**aucun contenu**. Le seul score qu'il tient est celui de la **soirée**, calculé
à partir du classement que le jeu lui rend (voir « Score de soirée »). Les sept serveurs de jeu (morpion, imitation, demicercle, ban,
precision, passeur, qui-ment) restent seuls arbitres de leurs parties. Si une
notion de gameplay apparaît un jour dans `src/`, c'est que la frontière a bougé
au mauvais endroit.

## Ce qui n'est pas encore là

Volontairement absents :

| | |
|---|---|
| score de soirée pour les SIX autres jeux (seul Le Passeur rend son classement) | phases suivantes |
| historique de CONTENU (`usedContent`), rejouer | phases tardives |
| compte, authentification | jamais |
| base de données pour autre chose que les **statistiques de joueur** (facultative, voir plus bas) | jamais |
| matchmaking public | jamais — c'est un Hub entre amis |

Aucun des sept serveurs de jeu n'a été modifié, et aucun ne l'est par ce dépôt.

## Lancer

```bash
npm install
npm start            # écoute sur $PORT, 8100 par défaut
npm test             # modèle, puis protocole, puis bout en bout
```

Variables d'environnement : `PORT` (8100), `MANIFEST_URL` (défaut : le
manifest publié par GitHub Pages, `https://mathyslan.github.io/data/games.manifest.json`),
`MANIFEST_FILE` (un fichier local à la place — tests, développement hors ligne),
`DATABASE_URL` (Postgres des statistiques de joueur ; absente = pas de
statistiques, tout le reste inchangé), `HUB_STATS=memory` (statistiques en
mémoire, pour les tests du portfolio, si pas de `DATABASE_URL`).

## Modèle

### Session

```js
{
  id,                    // interne — NE SORT JAMAIS ; le code est la poignée publique
  code,                  // 5 caractères, public
  hostId,
  state,                 // voir plus bas
  createdAt,
  players: [ … ],
  sockets: Map,          // à CÔTÉ des joueurs, jamais dedans
  draw: null,            // le tirage courant, ou le dernier confirmé (voir « Randomizer »)
  drawCount: 0,          // numérote les tirages
  history: { played: [], usedContent: {}, games: [] },   // played grandit à chaque tirage, jamais remis à zéro ;
                                                          // games = parties dont le classement est revenu
  scores: {},            // score de SOIRÉE : playerId → points cumulés (voir « Score de soirée »)
  constraints: { maxMinutes: null },           // réglé par l'hôte
  maxPlayers, graceMs
}
```

### Player

```js
{
  id,                    // fourni par le client, valeur OPAQUE
  name,                  // ≤ 16 caractères
  avatar: { kind: 'emoji' | 'image', emoji, src? },
  caps:  { mic: false },  // DÉCLARATIF, faux par défaut ; clés : mic, cam, consent
  veto:  [],             // ids de jeux — modifiable par le joueur LUI-MÊME seulement
  love:  [],
  connected,             // un socket vivant est-il attaché ?
  since                  // interne, ne sort pas
}
```

⚠️ `player.id` **ne prouve rien**. L'autorité vient du socket, comme dans les
sept jeux. Cet id sert uniquement à se reconnaître dans SA session lors d'une
reconnexion.

### États

`lobby` → `drawing` → `launching` → `inGame` → `debrief` → … → `finished` → (supprimée)

Le randomizer en fait vivre quatre :

| État | Quand |
|---|---|
| `lobby` | le salon, avant le premier tirage |
| `drawing` | un tirage est demandé (`draw.status: 'pending'`), puis révélé (`'drawn'`) |
| `debrief` | l'hôte a confirmé (`'confirmed'`) : retour au Hub, prêt pour la suite — ou le tirage suivant |
| `finished` | **l'hôte a terminé la soirée** (`finish`) : podium figé, plus rien ne démarre, plus aucune reprise ; gardée 10 min pour rendre le podium, puis supprimée |
| `closed` | fin (la session est supprimée dans la foulée) |

`launching` et `inGame` restent réservés au handoff : **aucune transition ne
les atteint aujourd'hui**. On entre dans une session en `lobby`, `drawing` ou
`debrief`.

## Protocole WebSocket

Même convention que les sept jeux : le client envoie `{ action }`, le serveur
renvoie `{ type }`, en JSON sur un seul socket.

### Client → serveur

| `action` | Charge | Effet |
|---|---|---|
| `create` | `player` | crée une session, l'appelant devient hôte |
| `join` | `code`, `player` | rejoint, ou **reprend sa place** si l'id est déjà connu |
| `leave` | — | quitte tout de suite, sans délai de grâce |
| `prefs` | `love[]`, `veto[]` | ses PROPRES ❤️ / 🚫 (ids de jeux) |
| `caps` | `caps` (`{ mic: true }`) | ses PROPRES capacités, déclaratives |
| `constraints` | `maxMinutes` (ou `null`) | **hôte** — durée maximale d'un jeu |
| `draw` | — | **hôte** — « tire le prochain jeu ». Aucun autre champ n'est lu |
| `continue` | — | **hôte** — prend acte du jeu tiré (et lance le handoff si le jeu le sait) |
| `launched` | `drawId`, `roomCode`, `gamePlayerId?` | **hôte du lancement** — sa page de jeu a créé la room (et il y est assis à cette place) |
| `entered` | `drawId`, `roomCode`, `gamePlayerId?` | chacun — sa page de jeu est entrée dans CETTE room, à cette place |
| `results` | `drawId`, `gameId`, `results[]` | **hôte du lancement** — le classement final de la partie (score de soirée) |
| `started` | `drawId` | **hôte du lancement** — la partie a démarré |
| `ended` | `drawId` | **hôte** — la partie est finie, retour au Hub |
| `abort` | `drawId`, `reason`, `detail` | création/entrée impossible, ou annulation (hôte) |
| `finish` | — | **hôte**, au salon (`lobby` / `debrief`) — termine la SOIRÉE pour tout le monde. ≠ `leave` |
| `stats` | — | SES statistiques de joueur (désigné par son socket). Voir « Statistiques de joueur » |
| `public-profile` | `playerId` | le profil PUBLIC d'un joueur de TA session, dont la clé y a été vérifiée. Voir « Profils publics » |
| `achievements-seen` | `codes[]` | ces notifications de succès ont été AFFICHÉES (page /games/) : le Hub ne les renverra plus. Ne débloque rien. Voir « Succès » |

### Serveur → client

| `type` | Charge |
|---|---|
| `created` | `you` (l'id de l'appelant), `stats` (ce Hub sait-il répondre à `stats` ?), `profiles` (… et à `public-profile` ?), `session` |
| `joined` | `you`, `stats`, `profiles`, `session` |
| `stats` | `stats` : `{ played, solo, wins, podiums, best, games[], records, achievements[] }`, ou `null` + `reason` (`UNAVAILABLE` / `UNVERIFIED`) |
| `public-profile` | `playerId`, `profile` (`{ name, avatar, present, stats }` ou `null`), `reason` (`null`, `NOT_FOUND`, `UNVERIFIED`, `UNAVAILABLE`, `BUSY`) |
| `achievement` | `unlocked[]` : `{ code, at, drawId }` — tes succès débloqués PAS ENCORE notifiés (après un classement, et à chaque entrée vérifiée) |
| `session` | `session` — diffusé à tous à chaque changement |
| `error` | `code`, `message` (`SESSION_CLOSED` d'une soirée terminée porte `finale` si l'on en faisait partie) |
| `finale` | `finale` — la soirée est terminée : le podium figé, à tous les connectés. Le socket est ensuite fermé (4002) |

`session` est l'**état public** : `{ code, state, hostId, maxPlayers, players[],
constraints, draw, history, scores, launch, pool }`. Ni socket, ni identifiant interne.
`pool` = ce que le moteur dit du catalogue pour CE groupe, recalculé à chaque
diffusion : `{ catalog, games[], eligible[], why{}, weights{}, health{} }`.
`launch` = le lancement en cours : `{ drawId, gameId, url, stage, hostId,
roomCode, expected[], entered[], waiting[], missed[], failed{}, reason, scored,
expiresInMs }` (null hors lancement).
Un `error` `NO_ELIGIBLE_GAME` porte en plus `why`.

### Erreurs

Les jeux n'envoient que `{ type: 'error', message }`. Le Hub ajoute un `code`
machine : il devra distinguer « code inconnu » de « session pleine » pour
proposer la bonne suite. Le `message` humain reste au même endroit.

| `code` | Quand |
|---|---|
| `BAD_JSON` | message illisible |
| `TOO_BIG` | au-delà de 32 Ko — le socket est fermé ensuite |
| `UNKNOWN_ACTION` | action hors de la liste |
| `BAD_PLAYER` | identité refusée (le `message` dit pourquoi) |
| `BAD_CODE` | code mal formé |
| `SESSION_NOT_FOUND` | aucune session avec ce code |
| `SESSION_FULL` | 12 joueurs déjà présents |
| `SESSION_CLOSED` | session terminée |
| `ALREADY_IN_SESSION` | ce socket est déjà dans une session |
| `NOT_IN_SESSION` | `leave` sans session |
| `REPLACED` | ce socket vient d'être remplacé par une autre connexion du même joueur |
| `NOT_HOST` | `draw`, `continue` ou `constraints` par un non-hôte |
| `DRAW_IN_PROGRESS` | un tirage est déjà en cours (`drawing`) |
| `NOT_DRAWN` | `continue` sans tirage révélé |
| `NO_ELIGIBLE_GAME` | aucun jeu possible pour ce groupe — `why` dit pourquoi, jeu par jeu |
| `MANIFEST_UNAVAILABLE` | catalogue illisible et aucun ancien en mémoire |
| `DRAW_FAILED` | erreur interne pendant un tirage (la session revient à son état) |
| `BAD_PREFS` / `BAD_CAPS` / `BAD_CONSTRAINTS` | réglage mal formé |
| `NOT_LAUNCHING` | aucun lancement en cours (ou déjà fini) |
| `LAUNCH_MISMATCH` | ce lancement ne correspond pas au tirage courant |
| `LAUNCH_CONSUMED` | le code a déjà été déclaré (usage unique) |
| `LAUNCH_EXPIRED` | déclaré après l'échéance |
| `BAD_ROOM_CODE` | code de room mal formé |
| `WRONG_ROOM` | ce n'est pas la room du groupe |
| `BAD_RESULTS` | classement mal formé (rang, points, place en double, aucun premier…) |
| `GAME_MISMATCH` | classement d'un autre jeu que celui lancé |
| `RESULTS_ALREADY` | le classement de ce lancement est déjà compté |
| `FINISH_NOT_ALLOWED` | `finish` pendant un tirage, un lancement ou une partie |

## Décisions, et pourquoi

### Le code a 5 caractères, pas 4

Relevé dans les sept serveurs : cinq tirent 4 signes dans
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, deux (passeur, qui-ment) tirent 4 lettres
dans un alphabet de 23. Le Hub reprend l'alphabet non ambigu — ni I, ni L, ni O,
ni 0, ni 1 — mais **passe à 5**, parce qu'un joueur aura bientôt deux codes en
main : celui de la session et celui de la partie. À 5 contre 4, on sait tout de
suite lequel on tient. 31⁵ = 28,6 millions de combinaisons.

### Un seul socket actif par joueur, et c'est le dernier qui gagne

Une seconde connexion avec le même `player.id` **ferme la première** (code
`REPLACED`, fermeture 4001). Le cas fréquent est un téléphone qui a perdu le
réseau et dont l'ancien socket met des minutes à mourir : refuser le nouveau
rendrait le retour impossible.

⚠️ **Contrepartie assumée** : quelqu'un qui connaît le code **et** un
`player.id` peut évincer son propriétaire. Entre amis, acceptable. À rediscuter
avant le handoff.

### Déconnexion ≠ départ

| Événement | Effet |
|---|---|
| **coupure réseau** (socket fermé, ou coupé par le heartbeat) | joueur **absent**, gardé **60 s** ; il reprend sa place en rejouant `join` avec le même `player.id` |
| **`leave`** (départ volontaire) | joueur **retiré tout de suite**, sans délai de grâce |
| plus **aucun joueur connecté** après l'un ou l'autre | session **supprimée immédiatement**, absents compris — sauf les exceptions ci-dessous |

La dernière ligne vaut pour les deux chemins : un salon où il ne reste que des
absents n'a plus de participant volontairement présent. Jusqu'au 2026-09-19,
un `leave` n'appliquait pas cette règle et la session survivait 60 s pour un
absent.

**Exceptions, sur une coupure seulement (jamais sur `leave`)** : une session
vide n'est pas fermée pendant `launching` / `inGame` (le groupe navigue vers
le jeu), ni au **debrief d'une partie terminée** (`debrief` + `launch.stage ===
'ended'` : le groupe revient du jeu au Hub, même onglet). Les délais de grâce
individuels font le ménage : le dernier absent retiré ferme la session. Avant
le 2026-09-27, le debrief n'était pas couvert : seul, revenir d'une partie
donnait « Ta session précédente n'existe plus » et le score de soirée était
perdu. Un `debrief` sans partie terminée (jeu tiré mais pas lançable) ferme
comme avant.

### Heartbeat : un ping toutes les 20 s

Une connexion morte (mode avion, Wi-Fi coupé, onglet tué par l'OS) n'envoie
aucune trame de fermeture : sans heartbeat, le joueur restait « connecté »
jusqu'à ce que TCP abandonne. Le serveur envoie un **ping WebSocket natif**
toutes les **20 s** ; une connexion qui n'a pas répondu au ping précédent est
coupée au tour suivant (`terminate()`), donc **détectée en 20 à 40 s**, puis
traitée comme n'importe quelle coupure (absent, grâce, reprise).

Pourquoi 20 s : assez court pour que le salon soit juste avant un lancement,
assez long pour ne rien coûter (2 octets par joueur) et laisser une connexion
lente répondre. Le navigateur répond aux pings dans sa pile réseau, sans code
côté page — même un onglet en arrière-plan. Un trafic régulier évite aussi
qu'un proxy ferme une connexion jugée inactive.

⚠️ Conséquence : un hôte seul qui recharge sa page perd sa session. C'est le
comportement demandé (« suppression de la session quand le dernier joueur
part ») ; une vraie survie demanderait un délai avant fermeture, à décider.

### 12 joueurs

C'est le `MAX_PLAYERS` de `precision-server`, le plus permissif des sept.
Plafonner à 8 interdirait une session de dix amis qui veulent jouer à Precision.
Le filtre par jeu viendra du manifest, avec le randomizer.

### L'image est acceptée ici, pas dans les jeux

Les six serveurs qui prennent un avatar font `String(avatar || '🙂').slice(0, 4)` :
une image n'y tiendra jamais. Une session de Hub n'est pas un protocole de jeu,
donc le Hub garde l'avatar complet en mémoire. Le jour du handoff, c'est
**l'emoji seul** qui partira vers le serveur du jeu.

⚠️ `slice(0, 4)` compte des unités **UTF-16**. Un emoji à ZWJ (👨‍👩‍👧 = 8
unités) serait coupé en plein milieu par les jeux : `src/identity.js` le refuse
ici, comme le client le refuse déjà.

## Randomizer

### Le catalogue : le manifest du portfolio, relu, pas recopié

`src/catalog.js` va chercher `data/games.manifest.json` sur GitHub Pages
(`MANIFEST_URL`, cache 5 min), exactement comme `ban-server` va chercher
`videos.json`. Mathys édite `data/games.js`, rebuild, push : **aucun
redéploiement Render**. `MANIFEST_FILE` le remplace par un fichier (tests).
Chaque jeu est relu ; un jeu mal formé est écarté, une version de schéma
inconnue refusée en bloc. Si GitHub Pages ne répond pas, l'ancien catalogue
sert encore.

### Filtrer → pondérer → tirer (`src/engine.js`, module pur)

**1. Filtre** — un jeu sort si l'une de ces raisons s'applique (toutes sont
renvoyées, pas seulement la première, dans `pool.why`) :

| Raison | Règle (valeurs du manifest, telles quelles) |
|---|---|
| `TOO_FEW` / `TOO_MANY` | `session.players.length` hors de `players.min..max` (absents compris : ils sont dans le groupe) |
| `LOCAL_ONLY` | `mode: 'local'` et plus d'un joueur (un jeu local tourne dans UN navigateur) |
| `NEEDS` | un `needs` que **un seul** joueur n'a pas déclaré — nommé |
| `VETO` | **un** joueur l'a mis en veto — nommé. Personne d'autre ne peut le lever |
| `TOO_LONG` | `minutes.max` > la durée max réglée par l'hôte (c'est le MAX qui compte) |
| `SERVER_DOWN` | le `/health` du jeu n'a pas répondu 2xx |

**2. Poids** — `(1 + 0,5 × nombre de ❤️) × récence`. Récence selon le dernier
passage du jeu : tirage précédent ×0,15, avant-dernier ×0,4, celui d'avant ×0,7,
sinon ×1. **Un cœur penche, il n'oblige pas ; la récence freine, elle n'interdit
pas** (à deux jeux possibles, un groupe alternerait sinon mécaniquement).

**3. Tirage** — pondéré, hasard cryptographique. Rien n'est tiré avant que la
liste éligible soit connue.

### Le tirage, côté Hub

- `draw` ne porte rien : ni jeu, ni nombre de joueurs. Tout est relu dans
  l'état serveur.
- L'état passe à `drawing` **synchronement**, avant tout `await` : un second
  `draw`, même dans la même milliseconde, reçoit `DRAW_IN_PROGRESS`. Deux
  tirages vivants, ou deux jeux pour un tirage, sont impossibles.
- Le Hub vérifie la santé des jeux pas encore vus vivants (GET en parallèle,
  40 s au plus : un serveur Render endormi a le temps de se réveiller), puis
  filtre sur l'état de **ce moment-là** — un veto posé pendant l'attente compte.
- Résultat : `draw = { id, n, status: 'drawn', by, gameId, eligible[], weights{},
  requestedAt, drawnAt }`, et `history.played.push(gameId)`. L'historique ne
  fait que grandir pendant la session ; une nouvelle session repart de zéro.
- Aucun jeu possible : `NO_ELIGIBLE_GAME` + `why`, **aucun repli**, la session
  revient exactement à son état d'avant.
- `continue` (hôte) : `draw.status = 'confirmed'`, état `debrief`. Le jeu ne se
  lance pas : c'est le point d'accroche du handoff.
- Revenir (reconnexion) ne déclenche rien : on retrouve le tirage en cours.
- **Enchaîner** : `debrief` → `draw` → `drawing` → `continue` → `debrief`…
  Le moteur est sans état : une « soirée en N jeux » ne serait qu'un compteur
  autour de ce cycle.

### Santé des serveurs de jeu (`src/health.js`)

Un **GET** sur l'URL `health` du manifest, rien d'autre : le Hub n'ouvre
**jamais** de WebSocket vers un serveur de jeu. `up` (2xx) vaut 5 min, `down`
(rien de 2xx avant 40 s) écarte le jeu 2 min.

⚠️ **Un serveur qui se réveille n'est pas un serveur mort.** Mesuré en
production le 2026-09-19 : depuis Render, le Hub déclarait les sept jeux
« down » en moins d'une seconde et le tirage ne trouvait AUCUN jeu — alors que
les mêmes URL répondaient 200 en 12 à 22 s vues d'ailleurs (le temps du réveil
Render). Dans la fenêtre de 40 s, une réponse non-2xx ou une erreur réseau
n'est donc plus un verdict : on réessaie toutes les 2,5 s. Seules une connexion
refusée et un nom inconnu tranchent tout de suite. La raison du dernier échec
est écrite dans les journaux (`[santé] passeur injoignable après 40 s : …`). Pré-réveil à la création
d'une session ; revérification avant chaque tirage si ce n'est plus frais. Un
jeu en cours de vérification n'est pas écarté du salon (il se réveille), mais
seul un jeu vu vivant peut être **tiré**.

## Handoff : lancer le jeu tiré

Le Hub n'ouvre **jamais** de WebSocket vers un serveur de jeu. Il orchestre des
navigateurs, qui parlent au jeu par son protocole habituel :

```
tirage → continue (hôte)      → stage 'create'   l'hôte ouvre le jeu
la page du jeu crée la room   → launched         stage 'join', le code part à tous
chaque invité rejoint le code → entered          quand tout le monde est là :
                              → stage 'playing'  état inGame
fin de partie                 → ended            état debrief, prêt à retirer
échec / annulation            → stage 'failed'   retour au salon, avec la raison
```

- Un jeu n'est lancé que s'il déclare `handoff: true` dans le manifest — c'est
  à dire si sa page sait être lancée (`games/shared/hub-handoff.js`). Sinon,
  `continue` revient au Hub comme avant.
- **Pas de jeton secret, et c'est délibéré.** L'autorité vient du SOCKET : seul
  l'hôte DU LANCEMENT (figé à `continue`) peut déclarer un code. Le lancement
  est lié au tirage courant (`drawId`), borné dans le temps et à usage unique —
  un jeton n'ajouterait rien à ces trois règles. Un invité qui déclare un code
  reçoit `NOT_HOST` ; un code qui n'est pas celui du groupe, `WRONG_ROOM`.
- Le Hub ne vérifie pas qu'une room existe (il ne parle pas au jeu) : c'est le
  premier invité qui le découvre, et son `abort` le dit au groupe.
- **Délais** : 90 s pour créer la room (sinon `LAUNCH_TIMEOUT`, retour au
  salon), puis 120 s pour que les invités entrent (sinon la partie est lancée
  sans eux, qui sont « manqués » et nommés).
- **L'hôte garde son rôle pendant tout le cycle**, même absent : il est en train
  de naviguer vers le jeu, dans le même onglet. Il ne le perd qu'en partant
  vraiment (leave, ou fin de sa grâce). Même règle au retour de partie.
- **Une session sans personne de connecté n'est PAS fermée** pendant
  `launching` / `inGame`, ni au `debrief` d'un lancement `ended` : tout le
  groupe navigue en même temps, à l'aller comme au retour.

## Score de soirée (`src/scores.js`, module pur)

Deux autorités qui ne se mélangent pas : **le jeu** reste maître de SA partie
(qui a gagné, avec combien), **le Hub** est maître de la SOIRÉE.

```
chaque joueur, en entrant dans la room  → launched / entered  { gamePlayerId }   sa place, déclarée par LUI
fin de partie, page de l'hôte           → results { drawId, gameId, results: [{ gamePlayerId, rank, points }] }
                                        → ended
```

- **Le lien joueur du jeu ↔ joueur du Hub** : l'hôte ne connaît pas
  l'identifiant de jeu des autres. Chacun déclare donc le sien en entrant, et
  le Hub relie une ligne du classement à la personne qui s'est assise à cette
  place. Une place déjà prise par un autre est refusée : l'hôte ne peut pas
  attribuer de points à quelqu'un d'autre. Les places ne sortent jamais.
- **Validations** : hôte du lancement (ou hôte actuel s'il est parti), `drawId`
  du lancement en cours, `gameId` du jeu lancé, partie lancée (`playing` ou
  `ended`), **une seule fois par lancement** (une revanche dans la même room ne
  compte pas), forme du classement. Une place inconnue du Hub (quelqu'un entré
  dans la room sans le Hub) occupe son rang mais ne marque rien.
- **Conversion, commune à tous les jeux** :
  `points de soirée = 10 × (nombre de classés − rang + 1)` — 10 par joueur
  battu, plus 10 pour avoir joué. À trois : 30 / 20 / 10 ; un ex æquo partage
  le rang. Pourquoi le rang : les points des jeux ne se comparent pas (Le
  Passeur va de 3 à 12 manches, le Morpion n'a pas de points), un classement
  si. Les points du jeu sont gardés tels quels dans `history.games`.
- `scores` commence vide (0 pour tous), survit aux tirages successifs et aux
  reconnexions, meurt avec la session.
- ⚠️ **Limite assumée** : le serveur du jeu ne parle pas au Hub, donc le
  classement transite par le navigateur de l'hôte. Même confiance que pour le
  code de room ; entre amis, ça suffit.

## Fin de soirée (`finish`, `src/finale.js`)

**Quitter ≠ terminer.** `leave` ne fait partir que soi : ses points restent
dans `scores`, les autres continuent. `finish` termine la soirée pour TOUT le
monde.

- **Qui** : l'hôte (`session.hostId`). C'est la règle unique d'`electHost`, sans
  exception ajoutée : si l'hôte part, son successeur peut terminer — sinon une
  soirée dont l'hôte est parti ne finirait jamais. Pendant et juste après un
  lancement, l'hôte du lancement garde la main (règle existante).
- **Quand** : `lobby` ou `debrief` seulement (`FINISH_NOT_ALLOWED` sinon) —
  jamais un groupe laissé dans une room orpheline.
- **Quoi** : `state = 'finished'`, `finale` calculée UNE fois par
  `finale.js` à partir de `scores` (rangs de compétition, ex æquo au même
  rang), envoyée à tous les connectés (`{ type: 'finale', finale }`). Puis
  chaque socket est détaché et fermé (4002), les grâces et minuteries sont
  annulées : plus aucune action possible.
- **`finale`** : `{ code, at, by, played, games[], ranking[] }` ; `ranking` =
  `{ playerId, name, avatar, points, rank, present }`. Y figurent tous les
  joueurs de la session (même à 0, même absents) ET ceux qui l'ont quittée
  après avoir marqué (`present: false` — nom et avatar gardés à leur départ,
  `session.departed`).
- **Après** : un `join` reçoit `SESSION_CLOSED` — jamais de reprise — avec
  `finale` si ce joueur figure au podium (rechargement, retour d'un absent) ;
  un inconnu n'apprend rien. Au bout de 10 min (`FINALE_KEEP_MS`), la session
  est supprimée : `SESSION_NOT_FOUND`.
- **Idempotent** : un second `finish` arrivé sur un socket déjà détaché reçoit
  la même finale ; la clôture n'a lieu qu'une fois.
- ⚠️ `/health` compte les soirées terminées encore en mémoire dans `sessions`.

## Statistiques de joueur (`src/stats.js`, lot H)

D'une soirée à l'autre : parties, victoires, podiums, meilleure place, par jeu.

- **Source de vérité : ce Hub.** Une ligne n'existe que parce que le Hub a
  ACCEPTÉ un classement (`results` → `onResults`, après `scores.apply`, qui
  ne change pas). Un client ne déclare rien ; il demande SES agrégats.
- **Stockage** : Postgres (`DATABASE_URL`, Neon en production), deux tables
  `hub_players` (id + empreinte sha256 de la clé) et `hub_plays` (une ligne par
  tirage et par joueur : rang du jeu, nombre de classés, combien derrière,
  points de soirée). Schéma créé au démarrage (`create table if not exists`).
  Agrégats calculés PAR LA BASE (`group by` jeu) : jamais d'historique
  téléchargé. `store-memory.js` a la même interface (tests).
- **Identité** : le player.id du profil, qui N'EST PAS secret (il est dans
  l'état public) — accompagné d'une **clé** (`player.key`, 32 à 64 caractères)
  qui ne sort que du navigateur du joueur. Premier passage d'un id :
  l'empreinte est enregistrée ; ensuite, autre clé = ni écriture ni lecture
  pour ce socket (la partie se joue quand même). Sans clé (ancien client) :
  pas de statistiques. La clé ne part jamais dans l'état public.
- **Définitions** : partie = partie classée où le joueur a une place (solo
  compris) ; victoire = rang 1 ET au moins un classé derrière (ni un solo, ni
  un nul du Morpion 1 / 1) ; podium = rang ≤ 3 à 2 classés ou plus ; meilleure
  place = plus petit rang à 2 classés ou plus. Le rang est celui du jeu, tel
  quel : ex æquo 1, 1, 3 → deux victoires, un 3e au podium.
- **Joueur parti** : sa ligne est enregistrée (il a joué, sa place le prouve) ;
  le score de SOIRÉE, lui, reste réservé aux présents.
- **Doublons** : `RESULTS_ALREADY` (une fois par lancement), puis la clé
  primaire `(draw_id, player_id)` + `on conflict do nothing` — même un renvoi
  après un redémarrage du Hub ne recompte rien.
- **Panne** : l'écriture est asynchrone, jamais attendue ; base injoignable →
  deux nouvelles tentatives, puis abandon (log). `stats` répond alors
  `UNAVAILABLE`, jamais un faux zéro. La soirée ne dépend jamais de la base.
- **Records** (lot I) : `stats.records`, dérivés du même résumé (`records()`).

## Succès (`src/achievements.js`, lot J)

Dix succès, décidés par CE Hub à partir des parties de `hub_plays`. Aucun
message client ne peut en débloquer un.

- **Rejeu** : les parties du joueur, triées (`played_at`, `draw_id`), relues
  une à une ; chaque succès est daté par la PREMIÈRE partie qui le rend vrai.
  Tous sont monotones. Codes : `first-win`, `explorer`, `stalemate`,
  `shared-throne`, `versatile`, `marathon`, `night-owl`, `hat-trick`,
  `crowd-king`, `grand-slam` (conditions dans `achievements.js`).
- **Définitions** : victoire = celle des statistiques ; partie compétitive = 2
  classés ou plus (le solo ne compte que pour `explorer`) ; soirée = parties
  compétitives consécutives, même code de session, ≤ 12 h entre deux ; série =
  parmi TES parties compétitives enregistrées de la soirée (défaite ou nul du
  Morpion la cassent, 1er ex æquo devant quelqu'un la continue) ; nuit =
  00:00:00–04:59:59 heure de Paris ; Grand Chelem = les 7 jeux en ligne,
  liste figée.
- **Table `hub_achievements`** `(player_id, code, unlocked_at, draw_id,
  notified_at)`, clé primaire `(player_id, code)` : `on conflict do nothing
  returning code` rend EXACTEMENT les nouveaux (premier déblocage, une seule
  fois, même si deux chemins se croisent). `notified_at` null = notification
  due.
- **Quand** : juste après les lignes d'un classement accepté (`debloque`), puis
  envoi `achievement` aux sockets vérifiés du joueur ; à chaque entrée vérifiée
  (`create` / `join` / reprise), rattrapage + envoi de ce qui attend
  (`auRetour`) ; à chaque `stats`, rattrapage. Seule la page /games/ affiche et
  accuse (`achievements-seen` → `notified_at`) ; la page d'un jeu ignore.
- **Rattrapage silencieux** : le jour où la table naît, dans la même
  transaction (verrou consultatif), les succès déjà mérités sont inscrits
  comme déjà notifiés (`notified_at = unlocked_at`) : aucune notification
  rétroactive, et un échec annule tout.
- **Limite** (celle du score) : le classement passe par le navigateur de
  l'hôte ; un hôte qui trafique sa page influence les succès liés au rang dans
  SES parties.

## Profils publics (lot K)

Voir le profil d'un AUTRE joueur de sa soirée : `{ action: 'public-profile',
playerId }` (`onPublicProfile`, `src/hub.js`).

- ⚠️ **Un player.id seul n'ouvre RIEN** (les ids circulent dans l'état de
  chaque session). Trois conditions : le demandeur est dans une session (son
  socket) ; la cible est dans CETTE session, présente ou partie
  (`session.departed`, lu par `hasOwnProperty`) ; la clé de la cible a été
  vérifiée DANS CETTE session (`verifies(session)`). Entrer avec l'id d'Alice
  sans sa clé (ou avec une autre) ne rend pas « Alice » consultable :
  `UNVERIFIED`, identité seule.
- **Pas d'oracle** : un id inventé et un joueur d'une autre soirée reçoivent
  la même réponse, `NOT_FOUND`. Les champs ajoutés au message (`code`…) sont
  ignorés : seul le socket désigne la soirée.
- **Contenu** : l'identité que le Hub connaît (nom, avatar, présent / parti),
  le résumé des statistiques (par jeu, records), les succès `{ code,
  unlocked, at }`. Jamais : la clé, son empreinte, un `drawId`,
  `notified_at`, les points, le code de session.
- **Lecture seule** : rien n'est débloqué ni notifié pour la cible. Une
  demande à la fois par socket (`BUSY`). Sans stockage : `profiles: false`
  dans `created` / `joined`, et `UNAVAILABLE`.

## HTTP

```
GET /health   (et GET / , même réponse)
{ "ok": true, "service": "game-hub-server", "protocolVersion": 1,
  "serverVersion": "0.1.0", "sessions": 0, "players": 0, "uptimeSec": 12 }
```

Pas de tableau de bord. `protocolVersion` change quand un client à jour ne peut
plus parler à un serveur ancien — pas à chaque correctif.

## Architecture

| Fichier | Rôle | Connaît le réseau ? |
|---|---|---|
| `src/codes.js` | tirage et normalisation des codes | non |
| `src/identity.js` | validation de l'identité cliente | non |
| `src/session.js` | modèle de session, joueurs, élection d'hôte | non |
| `src/serialize.js` | l'état public (liste **blanche**) | non |
| `src/protocol.js` | messages acceptés, codes d'erreur | non |
| `src/engine.js` | **le moteur de tirage** : filtre, poids, tirage — pur | non |
| `src/launch.js` | **le lancement** : états, validations, attente — pur | non |
| `src/scores.js` | **le score de soirée** : places, validation, conversion — pur | non |
| `src/stats.js` | **les statistiques de joueur** : définitions, clé, lignes à enregistrer — pur | non |
| `src/achievements.js` | **les succès** : définitions, rejeu, vue — pur | non |
| `src/store-pg.js` / `src/store-memory.js` | stockage des statistiques et des succès (Postgres / mémoire), même interface | Postgres / non |
| `src/prefs.js` | validation de prefs, caps, contrainte | non |
| `src/catalog.js` | lecture et validation du manifest | HTTP (GET) |
| `src/health.js` | santé des serveurs de jeu | HTTP (GET) |
| `src/hub.js` | le magasin de sessions et les handlers | oui |
| `src/http.js` | `/health` | oui |
| `src/server.js` | assemblage et démarrage | oui |

⚠️ `serialize.js` construit un objet neuf **champ par champ**. On ne prend
jamais la session pour en retirer des morceaux : avec une liste noire, un champ
interne ajouté demain partirait tout seul sur le fil. Un test le vérifie en
ajoutant un champ au modèle.

## Tests

```bash
node test-session.js   # 41 — modèle pur, sans réseau
node test-engine.js    # 65 — moteur de tirage pur, sur les valeurs du manifest réel
node test.js           # 37 — protocole, vraies connexions WebSocket
node test-presence.js  # 23 — heartbeat, leave, coupures, reprises (vraies connexions)
node test-draw.js      # 57 — randomizer sur vraies connexions : prefs, caps, tirage,
                       #      concurrence, reconnexion, serveur malade ou qui se
                       #      réveille, sécurité
node test-launch.js    # 43 — le lancement, module pur
node test-handoff.js   # 42 — le lancement sur vraies connexions : rôles, codes,
                       #      concurrence, délais, échecs, changement d'hôte
node test-scores.js    # 53 — score de soirée : module pur, puis `results` sur vraies connexions
node test-finale.js    # 34 — fin de soirée : podium (ex æquo, partis), hôte seul, états refusés,
                       #      double finish, reprise impossible, hôte déconnecté, pierre tombale
node test-debrief.js   # 31 — retour de partie : session vide gardée pendant la grâce
                       #      (solo, groupe), puis supprimée ; cas inchangés
node test-stats.js     # 50 — statistiques de joueur : définitions, stockage, protocole (clé, doublons,
                       #      parti, reconnexion, panne, solo, 9 joueurs) ; + 5 en SQL avec
                       #      TEST_DATABASE_URL (base de TEST, ses tables hub_* sont vidées)
node test-public-profile.js  # 27 — profils publics : soi, même soirée, autre soirée, ids forgés
                       #      et pièges (__proto__, constructor), usurpation d'id sans / avec fausse
                       #      clé, joueur sans clé, parti, panne, Hub sans stockage, aucune fuite
node test-achievements.js  # 78 — succès : définitions aux bornes (nuit, heure d'été, soirée,
                       #      séries, ex æquo), rejeu, stockage, protocole (premier déblocage,
                       #      accusé, reconnexion, joueur parti, panne, rien depuis un client) ;
                       #      94 avec TEST_DATABASE_URL (dont le rattrapage silencieux)
node test-e2e.js       # 26 — le vrai serveur, HTTP et tirage compris
```

`test-draw.js` et `test-e2e.js` n'utilisent PAS le réseau : le catalogue est
un fichier local aux valeurs du manifest réel, et les `/health` des jeux
pointent vers un faux serveur HTTP local (ou le Hub lui-même) — qu'on rend
malade, lent ou mort à volonté.

`test-presence.js` simule une connexion MORTE avec un client `ws` créé en
`autoPong: false` : il ne répond plus aux pings, comme un téléphone hors ligne.

`test.js` monte le hub à la main pour raccourcir le délai de grâce à 200 ms ;
c'est `test-e2e.js` qui démarre **`src/server.js` tel quel** — sans lui,
personne ne vérifierait que l'assemblage se lance.

⚠️ Dans ces tests, on n'attend jamais « le prochain message `session` » : la
diffusion déclenchée par l'action **précédente** peut arriver juste après et se
faire passer pour elle. On attend un état qui satisfait une **condition**
(`c.until(...)`). Les deux premiers échecs de ce dépôt venaient exactement de
là — et le serveur, lui, était correct.
