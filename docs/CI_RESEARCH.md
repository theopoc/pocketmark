# Recherche : CI et développement de Pocketmark

Recherche effectuée le 23 octobre 2026. Les sources externes ci-dessous sont des documentations ou dépôts officiels. Les recommandations et la grille sont notre appréciation pour ce projet ; elles ne constituent pas un standard de certification.

Le périmètre est un petit projet Go, SQLite avec CGO, interface et extension sans dépendances de production côté navigateur, exécutables et images Linux AMD64/ARM64. Les contraintes du dépôt sont dans [AGENTS.md](../AGENTS.md), les commandes dans le [Makefile](../Makefile) et le fonctionnement détaillé dans [CI.md](CI.md).

## 1. Flow conseillé

Conserver une branche `main` intégrable, une branche de travail courte par changement cohérent, et une PR vers `main`. La PR explique le problème, le comportement résultant et les vérifications. Une PR brouillon permet un retour précoce. Cette approche reprend le [GitHub flow officiel](https://docs.github.com/en/get-started/using-github/github-flow), qui recommande notamment une branche distincte pour les changements indépendants.

Pour Pocketmark, nous recommandons des branches courtes et le squash merge : une PR cohérente donne un commit facile à relire et révoquer. GitHub précise que [le squash convient aux branches courtes](https://docs.github.com/en/pull-requests/reference/pull-request-merges) ; Release Please [recommande aussi ce mode](https://github.com/googleapis/release-please#linear-git-commit-history-use-squash-merge) et déduit les versions des Conventional Commits. Valider le titre de PR protège donc le message qui sera proposé pour le squash. Relire ce message avant le merge reste nécessaire, car il est éditable.

Le contrôle de titre doit réagir à `edited` en plus de `opened`, `synchronize` et `reopened` : les événements PR par défaut ne couvrent pas les changements de métadonnées. Il doit aussi couvrir les PR de version, avec leur titre généré, et éviter de bloquer les exécutions `push`, réutilisables ou manuelles sans contexte PR. [Événements GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

Un GitFlow avec `develop`, branches de stabilisation permanentes et multiples voies de promotion ajouterait ici une coordination que le besoin actuel ne justifie pas. C'est une recommandation de proportionnalité, pas une interdiction technique. De même, réserver la merge queue à un volume réel de merges concurrents ; GitHub la présente comme particulièrement utile aux branches très actives. Si elle est activée, ajouter `merge_group` aux déclencheurs des checks requis. [Protection des branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

## 2. Protéger réellement `main`

Un YAML vert ne prouve pas que le merge est protégé. Vérifier séparément les règles actives côté GitHub : PR obligatoire, check `CI passed` requis, source GitHub Actions attendue, branche à jour, conversations résolues, absence de force push et de suppression de `main`, application aux administrateurs si le modèle de contribution le permet. GitHub distingue les checks « stricts » avec mise à jour de la branche et « souples » ; ses règles peuvent aussi sélectionner l'application autorisée à produire le check. [Documentation des branches protégées](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Pour un mainteneur seul, une approbation humaine externe obligatoire peut rendre tout merge impossible. Notre recommandation est de préserver les PR, la revue explicite et la CI obligatoire, puis de rendre l'approbation externe obligatoire lorsque des reviewers sont réellement disponibles. Ne pas attribuer de points à une politique seulement écrite : conserver une preuve de lecture API des règles et paramètres effectivement actifs. [API de protection des branches](https://docs.github.com/en/rest/branches/branch-protection).

## 3. Un check final qui échoue correctement

GitHub peut considérer des jobs `skipped` ou `neutral` comme acceptables pour un check requis. Un job dépendant peut également être sauté après l'échec d'un préalable. La recommandation officielle est un agrégateur avec `always()` et `needs`, qui rejette explicitement chaque résultat différent de `success`. Les checks doivent porter sur la révision requise par la PR, pas sur un ancien commit. [Dépannage des checks requis](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Le job `required` de [ci.yml](../.github/workflows/ci.yml) applique déjà ce principe pour `quality`, `security` et les matrices séparées `test` et `build`. Conserver cette propriété quand on ajoute un job. Ajouter une régression du contrat de workflow est pertinent : un futur gate oublié dans `needs` ne doit pas devenir facultatif silencieusement. Éviter les filtres globaux par chemin sur le workflow requis, car un workflow entièrement sauté peut laisser le check en attente. [Dépannage officiel](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

## 4. Frontière de confiance et dépendances de CI

Garder `contents: read` par défaut et accorder les écritures uniquement aux jobs qui publient. Pinner les actions au SHA complet ; les tags sont déplaçables. Passer les données non fiables, notamment un titre de PR, dans une variable d'environnement et les citer dans le shell au lieu de les injecter directement dans le texte de `run`. Ces mesures sont recommandées dans la [référence de sécurité GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).

Les PR externes exécutent du code non fiable : conserver `pull_request`, un token sans droits d'écriture et aucun secret de publication. Éviter de remplacer ce flux par `pull_request_target` qui checkout et exécute le contenu de la PR ; cela expose les droits du dépôt de base. Les mêmes risques existent lorsqu'un workflow privilégié récupère et exécute des artefacts non fiables. [Explication officielle du risque](https://github.com/github/docs/blob/main/content/actions/reference/security/securely-using-pull_request_target.md).

La CI lue applique déjà les SHA complets, les permissions limitées et `persist-credentials: false`. Conserver aussi les versions et vérifications d'intégrité des outils téléchargés. Les pins doivent être entretenus : Dependabot sait proposer les mises à jour d'actions et workflows réutilisables ; si un outil de mise à jour est déjà installé, étendre sa configuration plutôt que dupliquer les bots. [Mise à jour des actions avec Dependabot](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/auto-update-actions).

## 5. Vérification adaptée à Go, SQLite et Docker

Maintenir les tests Go `-race` : ils détectent les courses rencontrées pendant l'exécution, sans prouver leur absence dans tous les chemins. Le détecteur requiert CGO et un compilateur C ; les architectures doivent être supportées. C'est cohérent avec le besoin SQLite du dépôt. La couverture aide à repérer les chemins peu exercés ; un seuil global arbitraire ne remplace pas les régressions sur migrations, auth, archives et SSRF. [Détecteur de courses Go](https://go.dev/doc/articles/race_detector).

`govulncheck` analyse les fonctions vulnérables atteignables et réduit le bruit par rapport à une simple liste de dépendances. Garder les mêmes build tags SQLite que l'application. Un scan exécuté seulement lors d'un changement ne réévalue pas un commit inchangé après une nouvelle alerte : nous recommandons donc une exécution planifiée et manuelle du scan, sans publication. [Gestion officielle des vulnérabilités Go](https://go.dev/doc/security/vuln/).

Planifier en dehors du début d'heure et traiter ce contrôle comme une surveillance à résultat observable : GitHub avertit que les événements planifiés peuvent être retardés ou perdus sous charge. La dernière exécution doit être inspectable ; une planification seule n'est pas une preuve de surveillance réussie. [Dépannage des workflows planifiés](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows).

Tester les images réellement construites reste utile en plus des tests de code. Docker recommande des bases minimales, des builds multi-stage et la construction et vérification en CI. Pinner une base par digest rend le choix de contenu explicite, mais impose un flux de mise à jour pour les correctifs. [Bonnes pratiques Docker](https://docs.docker.com/build/building/best-practices/).

La matrice native AMD64/ARM64 et le smoke Compose du dépôt vérifient déjà des risques concrets de distribution CGO et de persistance. Conserver des données jetables et l'absence de dépendance aux sites web publics. Séparer les benchmarks réseau et RAM du gate déterministe, comme décrit dans [BENCHMARK.md](BENCHMARK.md). Ce constat provient du [workflow CI](../.github/workflows/ci.yml) et de [CI.md](CI.md), pas d'une exécution réelle dans cette recherche.

## 6. Publication et intégrité des artefacts

La publication doit consommer les artefacts vérifiés de la révision visée, avec contrôle du commit et du digest. Dans le dépôt, [release.yml](../.github/workflows/release.yml) réutilise CI puis télécharge les exécutables ; [container-release.yml](../.github/workflows/container-release.yml) teste les digests registre avant le tag et après publication. Préserver cette chaîne et le mode manuel sans publication par défaut. Ce sont des observations du code, à confirmer par les runs de livraison.

Distinguer immutabilité imposée par nos scripts et immutabilité native du service. GitHub peut verrouiller les assets et le tag après publication d'une release immuable ; sa séquence recommandée est brouillon, ajout de tous les assets, puis publication. Vérifier que le réglage est activé et compatible avec le pipeline avant de revendiquer cette garantie. [Releases immuables GitHub](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

Une provenance signée lie un artefact au workflow et à sa source ; elle ne garantit pas l'absence de vulnérabilité. GitHub recommande de signer les artefacts distribués et souligne que les attestations doivent être vérifiées pour apporter un bénéfice. Notre recommandation est d'ajouter provenance et SBOM lorsque l'on peut aussi documenter et tester la vérification côté consommateur. Leur absence n'est pas un motif pour refondre toute la CI personnelle. [Concepts et limites des attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

Les attestations GitHub sont disponibles sur les dépôts publics avec les offres courantes ; les dépôts privés nécessitent Enterprise Cloud selon la documentation consultée. Vérifier la visibilité et l'offre réelles. Leur génération utilise notamment `id-token: write` et `attestations: write`, à limiter aux jobs de publication. [Configuration officielle](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

BuildKit peut attacher provenance et SBOM dans des manifests supplémentaires de l'index OCI. Le pipeline actuel impose deux manifests exécutables et désactive ces métadonnées : activer les attestations exige donc d'adapter le contrôle de l'index et ses tests, ou de choisir des attestations attachées séparément au digest. [Stockage des attestations Docker](https://docs.docker.com/build/metadata/attestations/), [workflow conteneurs](../.github/workflows/container-release.yml).

## 7. Coût, diagnostic et récupération

Annuler les runs de validation dépassés par un nouveau commit et borner chaque job évite des ressources consommées sans résultat utile. Garder une concurrence distincte pour la publication, sans annuler une publication en cours. GitHub précise que les groupes de concurrence peuvent annuler des runs et que les noms doivent distinguer les workflows. Mesurer la durée et la flakiness avant de découper davantage la matrice ; un découpage supplémentaire n'est pas automatiquement un gain. [Syntaxe de concurrence et timeouts](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

Des preuves de sept jours peuvent suffire au diagnostic courant mais ne constituent pas un historique durable de release. Notre recommandation : conserver les checksums et la révision avec la release, un résumé lisible par run, et une procédure de reprise qui ne déplace jamais un tag existant. Le dépôt dispose déjà de procédures de répétition et reprise dans [CI.md](CI.md) ; évaluer leur cohérence avec les scripts et la publication observée.

Attention à une évolution de GitHub : la documentation consultée indique que les PR créées ou mises à jour par `GITHUB_TOKEN` peuvent désormais produire des runs `pull_request` nécessitant une approbation. `workflow_dispatch` et `repository_dispatch` déclenchent toujours un run. Le dispatch explicite utilisé pour les PR Release Please reste donc adapté pour éviter cette dépendance à une approbation et l'ajout d'un PAT ; l'ancienne affirmation « aucun événement PR n'est émis » mérite une nuance. [Déclenchement de workflow depuis un workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## 8. Grille d'évaluation proposée sur 20

Évaluer les dix critères ci-dessous sur deux points chacun. Pour chaque critère : **0** si absent ou contournable sans contrôle, **1** si partiel ou uniquement documenté, **2** si complet et appuyé par les preuves applicables. Des demi-points sont possibles si la lacune est nommée. Figer la grille avant de modifier la CI ; ne pas changer ses poids pour atteindre le seuil.

| Critère | Conditions pour 2/2 | Preuves attendues |
| --- | --- | --- |
| 1. Flow et PR | Branche dédiée, PR cohérente, squash/Conventional Commit compatible release, procédure claire | Paramètres de merge, contrôle titre, instructions et PR réelle |
| 2. Protection de `main` | PR et check requis, provenance du check, mise à jour de branche, force push/suppression bloqués, politique de bypass explicite | Réponse API des protections/rulesets actifs |
| 3. Contrat des gates | Tous les jobs nécessaires alimentent un check stable qui rejette échec, annulation et skip | Workflow, régressions du gate, checks du dernier commit |
| 4. Qualité et tests | Lint, modules, tests Go/race et JS, régressions ciblées et outils de release | Commandes versionnées et jobs verts |
| 5. Intégration et plateformes | CGO et tags réels, AMD64/ARM64 natives, image/Compose/persistance vérifiés | Matrice, smoke et rapports synthétiques |
| 6. Isolation et permissions | PR sans secrets privilégiés, droits minimaux, pas d'exécution de PR sous événement privilégié | YAML et réglages Actions pertinents |
| 7. Chaîne de dépendances | Actions SHA, outils maîtrisés, secret scan et vulnérabilités bloquants, entretien des pins | Configurations, versions et scans |
| 8. Release | Source exacte, artefacts/digests vérifiés, gates avant publication, pas d'écrasement, reprise documentée | Scripts, tests et flux de publication |
| 9. Exploitation CI | Timeouts, concurrence adaptée, traces lisibles et rétention explicite | YAML, résumé de run, documentation |
| 10. Entretien continu | Scans sans changement de code, actualisation des dépendances et politique supply chain proportionnée | Workflow planifié/manuel, bot de mise à jour, garanties et limites de provenance documentées |

Cette grille ne donne pas ici de note au dépôt : la recherche fournit le référentiel ; l'audit doit confronter l'implémentation, les paramètres distants et les checks réels au même barème avant et après les corrections. Un fichier modifié ou un check local seul ne prouve pas la réussite de la CI distante. Un contrôle distant indisponible doit rester signalé comme non vérifié, sans être crédité comme complet.
