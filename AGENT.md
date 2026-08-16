# AGENT.md

## Projet

Ropitone — PWA en JS vanilla (pas de build, pas de framework, pas de dépendance) qui
compte les sauts à la corde en analysant le signal du micro du téléphone. Fichiers clés :
`index.html`, `style.css`, `sw.js` (service worker, cache offline), `js/app.js`
(orchestration UI/état), `js/audio.js` (moteur de détection), `js/ui.js`, `js/storage.js`,
`js/wakelock.js`, `js/audio-clock-processor.js` (AudioWorklet).

## Algorithmes de détection (`js/audio.js`)

Sélectionnables via un slider 3 positions sur l'écran d'accueil, ou via le panneau
`?debug` :

- **legacy** — seuil RMS simple + hystérésis (state machine `BELOW`/`ABOVE`).
- **flux** (actuel, par défaut) — flux spectral positif + détection de maximum local sur
  3 frames + seuil adaptatif.
- **flux-v2** — comme `flux`, avec en plus une vérification de prominence (netteté réelle
  du pic depuis la vallée précédente) et un réarmement bas (hystérésis) pour éviter la
  dérive du seuil adaptatif.

Chaîne de signal commune aux trois : l'`AnalyserNode` est ouvert sur -90/0 dBFS (les
défauts -100/-30 écrêtaient le pic à 255 dès que le gain de sensibilité était appliqué), et
le flux comme le ratio HFC ne sont calculés que sur la bande ~500 Hz–8 kHz, les bins graves
noyant l'onset dans le bruit de fond. Les statistiques de calibration du flux sont robustes
aux valeurs aberrantes (frames d'amorçage écartées + troncature du décile haut) : sans ça,
un seul outlier verrouille le plancher absolu au-dessus de tout pic atteignable.

## Consignes

- JS vanilla ES modules uniquement : pas de build, pas de framework, pas de nouvelle
  dépendance externe.
- Pas de suite de tests automatisée pour l'instant : valider par vérification manuelle
  (`node --check` sur les fichiers modifiés, session réelle dans un navigateur) avant de
  considérer une implémentation terminée.
- Une fois une implémentation terminée, sans erreur, et validée (tests passés s'il y en a
  un jour, sinon vérification manuelle concluante) : commit puis push directement, sans
  attendre une demande explicite.
- Tout nouveau fichier statique doit être ajouté à `SHELL_FILES` dans `sw.js`, avec un
  bump de `CACHE_NAME`.
- Les nouveaux réglages d'algorithme doivent rester ajustables en direct via le panneau
  `?debug` (suivre le pattern slider/input existant), pas seulement en dur dans le code.
