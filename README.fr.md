# GuideSats (nom provisoire)

**Un agent de voyage IA réserve un petit guide touristique mauricien et le paie en sats sur Lightning, mais seulement dans un mandat que le voyageur approuve et que l'agent ne peut pas modifier.**
Les sats attendent dans une facture « hold » jusqu'à ce que le voyageur montre un code de rendez-vous au guide.
Si une alerte cyclone GDACS pour Maurice arrive avant l'excursion, la facture est annulée et le voyageur est remboursé automatiquement.

[English version: README.md](README.md) · Réalisé pour le Dakar Bitcoin Hack 2026 · Licence MIT

> **Ce qui est réel, ce qui est simulé.** La démo tourne sur un Lightning **SIMULÉ** : un registre en mémoire avec factures « hold », marqué SIMULÉ sur chaque écran. Il écrit de vraies factures BOLT11, mais avec le préfixe regtest et sans signature : aucun portefeuille sur un vrai réseau ne pourrait les payer. L'adaptateur **Nostr Wallet Connect** pour de vrais portefeuilles est écrit et testé contre un faux client. Il **n'a pas encore été lancé** contre de vrais portefeuilles ; c'est le rôle de `npm run e2e:nwc`, qui demande deux portefeuilles de test (voir plus bas). Le décodage des factures, les contrôles, le mandat, l'agent et la règle cyclone sont le même code dans les deux cas.

## Lancer (une commande)

Il faut Node 22.13 ou plus récent. Ni compte, ni clé, ni Docker.

```bash
npm install && npm run demo
```

Ouvrez http://127.0.0.1:8787 sur cette machine (le serveur n'écoute que sur 127.0.0.1). La vue prévue est une fenêtre de la largeur d'un téléphone. Données de départ : un portefeuille voyageur de 120 000 sats et trois guides fictifs avec leurs excursions.

Le parcours principal prend environ 30 secondes :

1. **Portefeuille voyageur** : choisissez *Randonnée au lever du soleil au Morne Brabant*, puis **Réserver**. Le brouillon de mandat affiche le plafond, la clé du guide, la fenêtre de temps et « un seul paiement ».
2. **Approuver le mandat**. Votre navigateur crée un secret P, le garde, et n'envoie que H = SHA-256(P).
3. **Demander à l'agent de bloquer les sats**. La console de l'agent montre chaque appel d'outil. Les sats passent dans une facture « hold ».
4. La carte affiche le **code de rendez-vous** (P). Copiez-le.
5. Onglet **Guide** : collez le code et appuyez sur **Encaisser**. Le guide reçoit 21 000 sats.
6. Onglet **Agent** : **Déclencher une alerte cyclone GDACS** (un rejeu de la vraie fiche BELAL-24). Toute réservation bloquée est remboursée automatiquement. **Avancer de 13 h** montre une facture qui expire et rembourse.

Vous pouvez aussi écrire une demande à l'agent, en français ou en anglais : *« je veux voir la cascade de Chamarel »*.

**Plan B (portefeuilles sans facture « hold »).**
1. Choisissez **Payer après l'excursion** et approuvez le mandat (pas de secret).
2. Faites **Avancer de 13 h**.
3. Appuyez sur **L'excursion a eu lieu : confirmer**.
4. Appuyez sur **Demander à l'agent de payer le guide**.

L'agent ne paie que la facture que l'appli a elle-même demandée au portefeuille du guide, après votre confirmation, dans le plafond et la fenêtre.

## Tester

```bash
npm run check        # typecheck + 122 tests (unitaires, propriété, API) + les 4 scénarios de bout en bout ; hors ligne, sans clé
npm run e2e:sim      # les quatre scénarios de démo, sous forme de rapport
npm run test:e2e     # Playwright à 360 px (EN) et 412 px (FR) ; une fois avant : npx playwright install chromium
```

Tests clés :

- **Test de propriété** (fast-check). Il génère des suites aléatoires d'appels d'outils de l'agent : factures forgées, rejouées, croisées entre réservations ou illisibles, sauts d'horloge, alertes cyclone. Il vérifie ensuite **sur le registre** que le voyageur n'a jamais payé :
  - au-dessus d'un plafond ;
  - un bénéficiaire hors mandat ;
  - deux fois sur un même mandat ;
  - une réservation non approuvée.
- **Vecteur de test de la spécification BOLT11.** Le bénéficiaire est retrouvé à partir de la signature avec `@noble/curves`.
- **Règle cyclone sur des données GDACS enregistrées.** BELAL-24 (orange, Maurice) annule l'excursion ; FREDDY-23, GARANCE-25, HONDE-25, GAMANE-24 et FILIPO-24 ne l'annulent pas.
- **Instantané (snapshot) des journaux.** Aucun préimage, chaîne NWC, nom, e-mail ou téléphone n'y survit.

## Le problème, l'utilisateur, la portée

**Utilisateur principal : le petit guide indépendant** à Maurice. Par exemple un guide de randonnée au Morne, un bateau à Blue Bay, une famille qui guide à Chamarel.

De plus en plus de voyageurs préparent leur voyage avec des agents IA. Aujourd'hui, ces guides ont deux options :
- prendre un acompte par virement, ce qui est lent, coûteux pour les cartes étrangères et sans garantie de remboursement ;
- ne rien prendre, et perdre la journée si le client ne vient pas.

Maurice reçoit environ 1,3 million d'arrivées touristiques par an, et la saison cyclonique va de novembre à avril.

**Ce qui change :**
- Le guide reçoit un engagement avant le jour J, en sats, sur son propre portefeuille, sans frais de carte ni plateforme qui garde l'argent.
- Le voyageur ne peut pas perdre son argent à cause d'un guide absent ou d'un cyclone.
- L'agent ne peut jamais dépenser plus que ce qui a été approuvé.

**Estimation de portée (objectif pilote, pas un résultat mesuré) :** 20 guides × 5 excursions par semaine, soit environ 100 réservations et 1,5 à 2 millions de sats par semaine. Le même parcours convient à tout tourisme côtier ou saisonnier en Afrique, Sénégal compris.

## Comment ça marche

- **Mandat** : un plafond, la clé du guide, une fenêtre de temps et un usage unique. Seul le voyageur l'approuve ; l'agent n'a aucun outil pour l'approuver ou l'augmenter.
- **Contrôle de facture** : chaque facture est décodée avec `light-bolt11-decoder` avant tout paiement. On vérifie :
  - le réseau ;
  - le montant exact ;
  - que l'empreinte vaut H ;
  - l'expiration ;
  - le bénéficiaire, retrouvé à partir de la signature.
- **Un seul point de paiement** (`src/app/payments.ts`). Il réserve le mandat à usage unique de façon atomique avant de payer.
- **Facture « hold »** (NWC-03) : les sats sont bloqués, pas envoyés. Il y a trois issues :
  - le guide encaisse avec P au rendez-vous ;
  - une alerte cyclone annule ;
  - un délai expiré rembourse.
- **Agent** : un planificateur à règles, donc sans clé de LLM. Un planificateur LLM utiliserait les mêmes outils, sans rien de plus.

Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Modèle de menaces : [SECURITY.md](SECURITY.md).

## Contraintes (honnêtes)

- **Les factures « hold » sont récentes.** NWC-03 est un brouillon et peu de portefeuilles le prennent en charge. Le plan B (paiement après l'excursion, NIP-47 de base) est intégré : rien ne bouge avant l'excursion, et en cas de cyclone rien n'est payé.
- **La durée d'un « hold » est limitée.** L'agent bloque donc les sats peu avant l'excursion : à partir de 12 h avant, durée à mesurer lors du premier vrai essai.
- **Les budgets côté portefeuille (NWC-13) sont optionnels.** Sans budget, le mandat de l'appli reste le seul plafond.
- **Des portefeuilles de test sur un même nœud** signent avec la même clé, ce qui affaiblit le contrôle du bénéficiaire entre eux.
- **GDACS liste les pays touchés par événement.** Un cyclone qui passe près de Maurice sans y être listé ne déclenche pas la règle.

## Indicateurs à suivre

- Les réservations bloquées par semaine, et parmi elles les parts encaissées, remboursées pour cyclone et remboursées après expiration.
- Le délai entre l'approbation et le blocage.
- Le délai entre le scan du code et l'encaissement.
- Les refus classés par motif.
- Le poids de la PWA.

## Prochaine étape

1. Premier vrai essai NWC sur deux portefeuilles de test.
2. Un QR code pour le code de rendez-vous.
3. Des budgets imposés par le portefeuille.
4. Les alertes de la Météo mauricienne (MMS) comme seconde source.
5. Une interface en kreol morisien.

## Crédits

- **GDACS**, système mondial d'alerte et de coordination en cas de catastrophe (ONU et Commission européenne), pour les données cyclone enregistrées.
- **La spécification BOLT11**, pour le vecteur de test.
- **Bibliothèques :**
  - `@getalby/sdk`, `light-bolt11-decoder`, `@noble/curves`, `@noble/hashes`, `@scure/base`, Hono, Preact, fast-check, Vitest, esbuild et tsx (MIT) ;
  - TypeScript et Playwright (Apache-2.0).
- Tous les guides et toutes les entreprises des données de démo sont fictifs.

Licence : [MIT](LICENSE).
