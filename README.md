# game-hub-server

Orchestrateur de session du portfolio [mathyslan.github.io](https://mathyslan.github.io).
Un salon : un groupe d'amis, leurs identités, leur hôte. **Rien d'autre.**

```
PROFIL / JOUEURS  →  SESSION  →  (plus tard) SÉLECTION  →  HANDOFF  →  SERVEUR DE JEU
                     ▲ ce dépôt                                        ▲ les 7 existants
```

## Ce que le Hub ne fait pas — et ne doit jamais faire

Il ne connaît **aucune règle**, **aucun score**, **aucun secret**, **aucun
contenu**. Les sept serveurs de jeu (morpion, imitation, demicercle, ban,
precision, passeur, qui-ment) restent seuls arbitres de leurs parties. Si une
notion de gameplay apparaît un jour dans `src/`, c'est que la frontière a bougé
au mauvais endroit.

## Ce qui n'est pas encore là

Cette version est un **squelette de session**. Volontairement absents :

| | |
|---|---|
| randomizer, caisse Mann Co. | phase suivante |
| handoff vers un jeu, jeton de lancement | phase suivante |
| préchauffage des serveurs Render | phase suivante |
| historique de contenu, rejouer | phases tardives |
| compte, authentification, base de données | jamais |
| matchmaking public | jamais — c'est un Hub entre amis |

Aucun des sept serveurs de jeu n'a été modifié, et aucun ne l'est par ce dépôt.

## Lancer

```bash
npm install
npm start            # écoute sur $PORT, 8100 par défaut
npm test             # modèle, puis protocole, puis bout en bout
```

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
  draw: null,            // emplacement, vide à cette phase
  history: { played: [], usedContent: {} },   // idem
  maxPlayers, graceMs
}
```

### Player

```js
{
  id,                    // fourni par le client, valeur OPAQUE
  name,                  // ≤ 16 caractères
  avatar: { kind: 'emoji' | 'image', emoji, src? },
  caps:  { mic: false },  // préparés pour le randomizer, PAS encore lus
  veto:  [],
  love:  [],
  connected,             // un socket vivant est-il attaché ?
  since                  // interne, ne sort pas
}
```

⚠️ `player.id` **ne prouve rien**. L'autorité vient du socket, comme dans les
sept jeux. Cet id sert uniquement à se reconnaître dans SA session lors d'une
reconnexion.

### États

`lobby` → `drawing` → `launching` → `inGame` → `debrief` → `closed`

**Cette phase ne fait vivre que `lobby` et `closed`.** Les quatre autres sont
représentables par le modèle pour que la phase suivante n'ait pas à réécrire la
machine à états, mais **aucune transition ne les atteint aujourd'hui** : ils
n'existent que dans `STATES`.

## Protocole WebSocket

Même convention que les sept jeux : le client envoie `{ action }`, le serveur
renvoie `{ type }`, en JSON sur un seul socket.

### Client → serveur

| `action` | Charge | Effet |
|---|---|---|
| `create` | `player` | crée une session, l'appelant devient hôte |
| `join` | `code`, `player` | rejoint, ou **reprend sa place** si l'id est déjà connu |
| `leave` | — | quitte tout de suite, sans délai de grâce |

### Serveur → client

| `type` | Charge |
|---|---|
| `created` | `you` (l'id de l'appelant), `session` |
| `joined` | `you`, `session` |
| `session` | `session` — diffusé à tous à chaque changement |
| `error` | `code`, `message` |

`session` est l'**état public** : `{ code, state, hostId, maxPlayers, players[],
draw, history }`. Ni socket, ni identifiant interne, ni horodatage.

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

Fermer un socket marque le joueur **absent** et le garde visible 60 secondes.
Mais si **plus personne** n'est connecté, la session est supprimée
immédiatement — inutile de garder en mémoire un salon que personne ne regarde.

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
node test.js           # 37 — protocole, vraies connexions WebSocket
node test-e2e.js       # 20 — le vrai serveur, HTTP compris
```

`test.js` monte le hub à la main pour raccourcir le délai de grâce à 200 ms ;
c'est `test-e2e.js` qui démarre **`src/server.js` tel quel** — sans lui,
personne ne vérifierait que l'assemblage se lance.

⚠️ Dans ces tests, on n'attend jamais « le prochain message `session` » : la
diffusion déclenchée par l'action **précédente** peut arriver juste après et se
faire passer pour elle. On attend un état qui satisfait une **condition**
(`c.until(...)`). Les deux premiers échecs de ce dépôt venaient exactement de
là — et le serveur, lui, était correct.
