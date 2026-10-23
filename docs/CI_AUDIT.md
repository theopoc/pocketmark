# Audit de la CI Pocketmark — 23 octobre 2026

**Évaluation initiale : 15,5/20. Évaluation de cette branche après corrections : 18,5/20**, à retenir uniquement lorsque la CI distante de sa dernière révision est entièrement verte. La grille de dix critères sur deux points est détaillée dans [la recherche sur sources primaires](CI_RESEARCH.md). Ce score est une appréciation technique adaptée au projet personnel, pas une certification. Les poids sont identiques avant et après.

## Périmètre et preuve

L'audit initial porte sur `main` à `0d5888e58f46c763118bc543791a37069c235bae`, ses trois workflows, scripts de packaging/publication, Makefile et paramètres GitHub lus via API. Le dépôt source est public. Les règles sont des **rulesets**, pas une ancienne branch protection : un HTTP 404 sur cette dernière API ne signifie pas que `main` est sans protection.

Pendant l'audit, la [PR #25](https://github.com/theopoc/pocketmark/pull/25) a été fusionnée dans `main` (`7b1e25277482392ed986b12c11aa7be6ccaff586`). Sa correction de release est intégrée à la base de cette branche ; elle représente 0,5 point du progrès et n'est pas attribuée aux changements de cet audit. Sur cette base actualisée, la note avant nos changements est donc **16/20**. Les autres PR en cours ne sont pas créditées à cet audit.

Preuves distantes consultées :

- [Protect main](https://github.com/theopoc/pocketmark/rules/25546851) : actif, PR obligatoire, zéro approbation externe exigée, conversations résolues, historique linéaire, `CI passed` fourni par GitHub Actions (`15368`), branche à jour, suppression et force push interdits, aucun acteur de bypass.
- [Protect release tags](https://github.com/theopoc/pocketmark/rules/25546853) : mise à jour et suppression des tags `v*` interdites, aucun bypass.
- Paramètres du dépôt : squash seul et suppression automatique de branche. Permissions Actions par défaut en lecture ; création de PR autorisée pour Release Please. La politique globale de SHA n'est pas imposée côté serveur ; les workflows versionnés épinglent déjà leurs actions.
- [CI initiale de main](https://github.com/theopoc/pocketmark/actions/runs/40013260599) réussie ; [release initiale](https://github.com/theopoc/pocketmark/actions/runs/40013260552) échouée sur `fromJSON` avec sortie PR vide. La PR #25 apporte le fallback et les régressions d'expressions.
- Pour cette branche, consulter [les runs CI de l'audit](https://github.com/theopoc/pocketmark/actions/workflows/ci.yml?query=branch%3Aci%2Fpipeline-audit). La preuve de livraison est le run réussi correspondant à la dernière révision de la PR, pas un run antérieur ou un simple test local.

## Grille fixe

| Critère /2 | Initial | Branche corrigée | Justification et limite |
| --- | ---: | ---: | --- |
| 1. Flow et PR | 1,5 | 2 | Branches dédiées et squash existants ; titre Conventional vérifié, événements `edited` couverts, modèle de PR et procédure de merge ajoutés. Le mainteneur doit conserver le titre proposé au squash. |
| 2. Protection de main | 2 | 2 | Rulesets actifs vérifiés, source du check et mise à jour stricte imposées, sans bypass. Zéro reviewer externe reste proportionné à un projet personnel. |
| 3. Contrat des gates | 1,5 | 2 | Agrégateur `always()` existant ; nouvelles régressions exécutant son script réel, refus des résultats vides, et détection d'un job oublié dans `needs`. |
| 4. Qualité et tests | 2 | 2 | Formatting/vet, intégrité et tidy Go, syntaxe, race tests, tests UI/extension et packaging. Aucun seuil global de couverture arbitraire ajouté. |
| 5. Intégration et plateformes | 2 | 2 | CGO/FTS5 réels, Linux natif AMD64/ARM64, build statique et smoke Compose couvrant auth, stockage, sauvegarde et redémarrage. Les benchmarks réseau et appareils restent séparés. |
| 6. Isolation et permissions | 2 | 2 | PR en lecture sans secrets de publication, pas de `pull_request_target`, credentials checkout non persistés, écritures limitées aux jobs de publication. |
| 7. Chaîne de dépendances | 1,5 | 1,5 | Actions SHA, téléchargement Gitleaks vérifié, scans bloquants. Les images de base restent référencées par tags ; tous les pins d'outils ne sont pas mis à jour automatiquement. |
| 8. Release | 1 | 1,5 | Source/artefacts/digests vérifiés et tags protégés ; la PR #25 corrige le cas PR vide et documente la reprise. Une publication complète de cette révision n'est pas déclenchée pour cet audit ; provenance signée et SBOM absentes. |
| 9. Exploitation CI | 1,5 | 2 | Timeouts, concurrence et rétention existants ; résumé explicite des résultats des gates dans le run, y compris en échec. |
| 10. Entretien continu | 0,5 | 1,5 | CI complète hebdomadaire sans publication, Dependabot hebdomadaire groupé pour Actions/Go/Docker, limites de PR et politique documentées. Premier run planifié et premières PR bot restent à observer après merge : pas de 2/2 anticipé. |
| **Total** | **15,5** | **18,5** | **+2,5 points propres à cet audit, +0,5 via la PR #25 fusionnée en parallèle.** |

## Améliorations de cette PR

1. Le titre de PR devient une entrée vérifiée du futur squash/Release Please. Il est lu depuis le JSON de l'événement, sans interpolation dans du code shell. Les titres de release et Dependabot sont acceptés ; les titres multilignes ou sans préfixe conventionnel sont rejetés. Les runs sans contexte PR ne prétendent pas vérifier un titre.
2. La même CI tourne le lundi à 05:23 UTC sur la branche par défaut, sans publication. Cela réévalue les vulnérabilités et les changements de runners en l'absence de commit. GitHub peut retarder les schedules et les désactiver après 60 jours d'inactivité sur un dépôt public ; le premier passage réel n'est pas encore prouvé.
3. Dependabot propose les mises à jour Actions, modules Go et bases Docker. Les mineures/patches Go et Docker sont groupées, les majeures séparées ; deux PR de version maximum par écosystème. Aucun merge automatique. Garder la version du compilateur alignée entre Go et Docker reste une vérification humaine.
4. Les tests du gate exercent les résultats `success`, `failure`, `cancelled`, `skipped`, `neutral`, inconnu et vide. Ils contrôlent aussi que tous les jobs directs sont dans `needs`. Le résumé du run rend les résultats lisibles.
5. Le modèle de PR et la documentation exposent les preuves attendues, le merge strict, les conditions de publication et les limites des garanties. La description incorrecte du dépôt source comme privé et celle des événements de PR bot sont corrigées.

## Validation et limites pratiques

Contrôles locaux : `make check`, `make test` avec race detector, `make test-extension`, `make build`, tests Python des scripts, `actionlint` épinglé et validation des deux configurations GoReleaser. Le Go local est 1.27.1 et GoReleaser local 2.16.0 ; ils ne remplacent pas la preuve CI avec Go 1.26.10 et GoReleaser 2.18.3 épinglés. Les tests natifs Docker AMD64/ARM64 sont exécutés par la CI distante. Aucun Dockerfile ni configuration Compose n'est modifié ici.

Le scan Gitleaks de l'historique Git est sans fuite. Le scan du diff indexé doit être sans fuite avant chaque push. Un scan brut du disque voit deux détections dans les fichiers locaux ignorés de l'outil `.impeccable/` ; ces fichiers ne sont ni modifiés, ni ajoutés à cette PR, ni utilisés comme preuve de la sécurité du contenu livré.

La note finale exige que le SHA de tête de la PR soit celui vérifié par les checks (sur GitHub, le check PR peut s'exécuter sur le commit de fusion synthétique rattaché à cette tête). Tous les jobs attendus et `CI passed` doivent être `success`. Ni `pending`, ni `skipped`, ni une annulation ne satisfont cette condition. Les nouveaux schedules et Dependabot ne seront actifs sur le dépôt qu'après le merge ; cette PR ne fusionne pas `main` et ne publie pas de version.

## Suite recommandée, au-delà du seuil

- Observer le premier passage hebdomadaire et les premières propositions Dependabot. Revoir manuellement les outils épinglés hors de ses manifestes ; mesurer le temps de CI avant toute optimisation supplémentaire.
- Étudier une provenance signée et un SBOM avec une procédure de vérification consommateur testée. Les attestations BuildKit ajoutent des manifests : adapter auparavant le contrat qui impose exactement deux plateformes exécutables, ou attacher les attestations séparément.
- Envisager des bases Docker par digest avec renouvellement automatisé. Un digest oublié n'assure pas la fraîcheur de sécurité.
- Séparer le check de métadonnées si les éditions de PR causent trop de builds ; aujourd'hui elles rejouent toute la CI. Une merge queue exige `merge_group` et ne se justifie pas encore par le volume observé. Pas de branche `develop` permanente recommandée.
