# Audit de sécurité approfondi — 26 octobre 2026

**Verdict : trois faiblesses applicatives reproduites et corrigées, plus un
durcissement de restauration des sessions. Le déploiement Kubernetes n'est pas
encore validé.** Aucun résultat ne constitue une certification ASVS, ni une
garantie d'absence de vulnérabilité.

Les essais initiaux portent sur `bd2e946bf4794b025ad6e60247612ceba7216f99`
(les cinq correctifs du premier audit sont déjà présents). Les corrections sont
initialement basées sur `19ce3db`, puis intégrées sur `593bcf5`, qui ajoute la
limitation HTTP par client après les changements du popup de l'extension. Les
tests, le navigateur, le smoke et le probe mémoire sont rejoués avec cette
limitation activée par défaut. Les tests utilisent des bibliothèques, secrets, profils navigateur
et conteneurs jetables ; aucun pentest du cluster ou d'un service tiers.

Méthode : revue des chemins d'autorisation et des frontières de confiance,
tests Go, requêtes HTTP brutes, navigateur réel, fuzzing court, analyse des
dépendances et image locale. La [recherche sourcée](SECURITY_RESEARCH.md) relie
ces essais à OWASP ASVS 5.0.0/WSTG 4.2, aux standards HTML/CSP et aux références
Go/Kubernetes. Elle propose aussi des essais non exécutés : elle ne doit pas
être lue comme une liste de contrôles tous validés.

## Constats corrigés

| ID | Gravité et conditions | Preuve avant correction | Correction et régression |
| --- | --- | --- | --- |
| D01 | Moyenne, disponibilité ; clé API valide ou fichier hostile importé par le propriétaire | `{"links":[{},…]}` avec un million d'éléments, 3 000 011 octets, tue le conteneur 128 Mio : OOMKilled, code 137. Le plafond de 10 000 liens était contrôlé après allocation. | Réception bornée sur disque, prévalidation incrémentale avant décodage typé : collections, liens cumulés, favoris, tags, profondeur, clés répétées/casse, document supplémentaire. Les quatre variantes d'un million d'éléments retournent 400 ; santé et bibliothèque restent à 200. |
| D02 | Faible, navigation de l'archive ; HTML hostile enregistré et clic du propriétaire sur l'URL de prévisualisation directe | `<noscript><a href="/audit-probe/noscript">Click</a></noscript>` conserve son lien, visible lorsque le scripting est désactivé. Le clic obtient une réponse HTTP sur la destination. Aucune XSS, fuite de cookie ou exécution de script démontrée. | L'API HTML `/view` est servie en téléchargement. L'interface continue de récupérer ses octets pour son visualiseur blob imbriqué, dont la CSP parent bloque les navigations réseau. E2E : lien noscript **absolu**, clic réel, refus réseau, absence de réponse cible ; accès direct = téléchargement. PDF/images et téléchargement original préservés. |
| D03 | Moyenne, disponibilité ; une intégration authentifiée envoie lentement un import HTML | Le parseur ouvrait la transaction avant la fin de réception. Avec le lecteur bloqué : requête stats expirée (400), readiness 503, liveness 200. Le délai HTTP limite une requête à 30 s, sans empêcher sa répétition. | Réception de l'import sur un fichier de 8 Mio maximum avant toute transaction. Test concurrent : stats, readiness et liveness à 200 pendant le blocage du lecteur. Tests d'échec de lecture, annulation et dépassement : nettoyage des fichiers, aucune mutation partielle. |
| D04 | Durcissement opérationnel ; sauvegarde antérieure, cookie ancien et restauration avec le même secret | Un cookie révoqué après la sauvegarde redevient valide une fois celle-ci restaurée. C'est un retour en arrière de l'état d'authentification, pas un contournement anonyme. | Suppression des sessions dans la copie créée par `VACUUM INTO`, sans toucher aux sessions du serveur actif. Après restauration et redémarrage : ancien cookie refusé, nouvelle connexion possible, bibliothèque et clés d'intégration conservées. |

Pour D01, le nouveau plafond est de 10 000 favoris supplémentaires, 32 tags par
enregistrement et 64 niveaux JSON ; les limites existantes restent 8 Mio,
10 000 liens et 2 000 collections. Les occurrences répétées sont comptées
cumulativement. Les champs inconnus des exports historiques restent acceptés
dans ces limites. Les transactions d'import restent atomiques.

Pour D02, le tokenizer ne devient pas un sanitizer HTML5 complet. Les contextes
SVG/MathML/rawtext peuvent différer du navigateur. Le correctif place la garantie
sur le visualiseur et l'interdiction de rendu direct, sans créer un arbre DOM
complet de 20 Mio en mémoire. Les originaux téléchargés restent des fichiers non
fiables lorsqu'ils sont ouverts en dehors de Pocketmark.

Pour D04, les **anciens ZIP et copies brutes de base** contiennent toujours leurs
sessions : suivre les instructions de restauration, notamment la rotation du
secret de récupération. Une restauration peut aussi rétablir des clés API
révoquées depuis la sauvegarde ; leur revue reste nécessaire. Ce correctif
n'efface pas rétroactivement les anciens supports de sauvegarde.

## Preuves et limites de mesure

Les résumés synthétiques conservés sont :

- [Conteneur avant correction](security-audit/before-container.json) : UID/GID
  10001, racine en lecture seule, capacités retirées, 1 CPU, mémoire/swap total
  128 Mio. À 250 000 objets, pic cgroup 133 656 576 octets ; à un million, OOM.
- [Conteneur après correction](security-audit/after-container.json) : mêmes
  contraintes ; un million de liens, favoris, tags et second document refusés.
  Pic cumulatif observé 11 075 584 octets, environ 10,6 Mio. Le compteur cgroup
  inclut plus que le heap Go ; ce n'est pas une limite supérieure universelle.
- [Corpus navigateur initial](security-audit/before-browser.json) : Chrome
  156.0.8078.48, vingt charges dans deux contextes (direct et shell). Noscript
  direct est la navigation reproduite. Deux clics SVG foreignObject expirent :
  **inconclusifs**, pas « protection validée ». La présence d'un attribut href
  MathML ne suffit pas à prouver une navigation exploitable. Le premier test
  noscript du shell utilisait une URL relative ; seul le nouveau test absolu
  vérifie explicitement son refus par CSP.
- [HTTP brut initial](security-audit/before-http.json) : CL contradictoires,
  noms d'en-tête invalides, Host répété, TE inconnu, longueur négative, gros
  en-têtes, pipeline CL+TE, Expect/autorisation, chemins sensibles et keep-alive.
  Le pipeline reçoit 400 puis 401, sans accès non autorisé. Cela ne valide pas
  le cadrage entre un Ingress inconnu et le serveur.

Le [probe Docker reproductible](../scripts/security_import_probe.py) crée et
supprime son propre conteneur et son volume, sur une adresse loopback seulement :

```sh
docker build -t pocketmark-security-audit:fixed .
python3 scripts/security_import_probe.py --image pocketmark-security-audit:fixed --output /tmp/import-security.json
python3 scripts/smoke_docker.py --image pocketmark-security-audit:fixed --output /tmp/smoke-security.json
```

Le smoke standard valide le fonctionnement normal, SQLite/FTS5, l'authentification,
le refus de capture privée, les sauvegardes et le redémarrage ; il réussissait
déjà sur l'ancienne version malgré le DoS JSON. Il ne remplace donc pas le probe.

## Autres frontières examinées

| Surface | Résultat observé | Limite |
| --- | --- | --- |
| Authentification/autorisation | Clés nommées refusées sur compte, tokens et backup ; neuf routes refusées sans authentification ; variantes de chemins et schémas d'authentification sans promotion en propriétaire. Régressions de setup, révocation et limites du premier audit conservées. | Pas de résistance garantie à un vol du mot de passe ou du secret de récupération. |
| Origins/CSRF | Origins hostile, `null`, sous-domaine trompeur, schéma/port différent refusés ; types simples refusés sur login. | L'origine et les CIDR de proxies doivent correspondre à l'Ingress réel. |
| SSRF/DNS | 23 adresses privées/spéciales/transition, six alias numériques et DNS mixte refusés avant dial ; adresse publique validée passée numériquement au dialer sans seconde résolution. | Résolveur simulé ; pas une preuve d'isolation réseau du Pod. |
| SQL/FTS | Chaînes d'injection rejetées ou traitées sans exécution ; bibliothèque intacte. Requêtes paramétrées et tris contrôlés examinés. | Corpus ciblé, pas preuve exhaustive de tout chemin futur. |
| XML/XBEL | Entités externes/internes, double document, profondeur de dossiers et URL dangereuse refusés ; rollback conservé. | Sous-arbres inconnus profonds traversés rapidement dans le test ; ce n'est pas un plafond général de temps. |
| Fuzzing | Preview/Reader : 123 204 exécutions en 20 s ; XBEL : 608 652 en 20 s, deux workers, aucune panne. Cibles et seeds ajoutés aux tests. | Recherche de crash avec entrées ≤64 Kio ; ne démontre pas l'isolation HTML dans un navigateur. |
| Dépendances | govulncheck v1.1.4, Go 1.27.3 et tags SQLite : aucune vulnérabilité atteignable signalée. | Dépend de la base d'avis ; ne couvre pas toutes les failles métier/C/CGO. SQLite embarqué 3.53.4 inspecté. |
| Image | Trivy 0.69.3 : aucune CVE signalée pour l'image locale ARM64 ; 27 contrôles Dockerfile réussis. Base Trivy mise à jour le 26 octobre. Non-root, readonly, capacités et absence d'escalade vérifiées au smoke. | Trivy avertit que cette version Alpine n'est pas dans sa liste EOL ; scanner plus récent disponible. Pas d'attestation de l'image GHCR réellement déployée. |
| Secrets/CI | Scan Gitleaks historique redacted sans détection lors de l'audit ; actions épinglées et droits PR en lecture seule. | SBOM et provenance de l'image désactivés dans le workflow de release : durcissement de chaîne de livraison encore possible. |

## Vérification des correctifs

Les tests permanents sont dans `internal/store/import_bounds_test.go`,
`internal/server/deep_security_test.go`, les tests d'assets, les corpus sécurité
capture/XBEL et `e2e/browser.mjs`. Ils complètent les tests de migration et
compatibilité déjà présents. Le test de sauvegarde restaure puis rouvre la base,
et contrôle données, clés et cookies après redémarrage.

[Résultats de validation locale](security-audit/validation.json) : `make check`, `make test` avec race detector,
`make test-extension`, `make build`, tests ciblés de restauration, smoke Docker
et probe 128 Mio. Le parcours navigateur vérifie aussi les styles/images
embarquées, PDF natif, HTML historique, CRUD et déconnexion. L'image est une
construction locale de la branche ; elle n'a pas été publiée.

## Conditions encore nécessaires avant exposition Internet

Le contexte Kubernetes local ne contient aucun cluster configuré. Aucun manifeste
de déploiement cible, Ingress, CNI, certificat, règle réseau ou digest de release
n'a donc été validé. Avant exposition :

1. Déployer une image contenant ces corrections, identifiée par digest ; scanner
   cet artefact et confirmer sa provenance. Une CI de PR verte ne publie pas
   automatiquement une nouvelle image.
2. Vérifier HTTPS, origine exacte, cookie Secure, chaîne X-Forwarded-For, CIDR de
   proxies fiables, tailles/délais et absence d'accès direct contournant l'Ingress.
   Tester le cadrage HTTP de cette chaîne en environnement jetable.
3. Appliquer et tester réellement les restrictions réseau avec le CNI : refus
   des réseaux privés, metadata, API Kubernetes et services internes, IPv4/IPv6,
   tout en autorisant le DNS et les captures publiques nécessaires.
4. Confirmer non-root, rootfs readonly, `allowPrivilegeEscalation: false`,
   `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, absence de token
   ServiceAccount inutile, stockage privé, limites mémoire/CPU/stockage et sondes
   `/livez` et `/healthz` adaptées.
5. Tester sauvegarde et restauration hors production avec gestion des secrets,
   revue des clés restaurées et alertes disponibilité/espace disque. Valider
   une charge représentative du matériel cible ; 128 Mio ne sont pas garantis
   pour toutes les opérations simultanées et toutes les bibliothèques.

Ces contrôles sont des conditions de déploiement à vérifier, pas de nouvelles
failles déclarées dans un cluster qui n'a pas été observé.
