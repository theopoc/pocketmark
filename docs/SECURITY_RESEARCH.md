# Recherche : sécurité de Pocketmark avant exposition Internet

Recherche du 26 octobre 2026, sur la révision `bd2e946bf4794b025ad6e60247612ceba7216f99`. Cette note fournit une méthode et des cas de test ; elle ne prétend pas que les tests proposés ont été exécutés. Les résultats reproductibles, versions d'outils et limites doivent figurer dans le rapport d'audit associé. Aucun accès au cluster ni attaque d'un service tiers n'est nécessaire pour les essais applicatifs proposés.

## 1. Référentiel et niveau de preuve

Utiliser **OWASP ASVS 5.0.0**, version stable affichée par le projet, pour les exigences, et **WSTG 4.2**, cible actuelle du lien stable, pour les méthodes. Figer ces versions : les identifiants ASVS évoluent. Viser les contrôles applicables d'ASVS niveau 2 est une proposition de rigueur pour cette exposition Internet, pas une certification acquise. Une conformité exige une matrice exhaustive avec justification des exclusions et preuves ; cinq corrections ou un scan sans alerte ne la démontrent pas. [ASVS officiel](https://asvs.owasp.org/), [WSTG versionné](https://wstg.owasp.org/v4.2/).

Le modèle local est un propriétaire unique, des clés d'intégration moins privilégiées, des pages distantes hostiles et une base SQLite contenant données privées et matériel d'authentification. Les frontières à vérifier sont : Internet → proxy → serveur ; clé d'intégration → administration ; URL fournie → réseau interne ; fichier HTML → navigateur du propriétaire ; import → bibliothèque existante ; publication → image exécutée. Ce découpage provient des contrats [API](API.md), [archives](ARCHIVES.md), du [serveur](../internal/server/server.go) et de la [capture](../internal/capture/capture.go).

Pour chaque essai, conserver l'entrée synthétique, la révision, le résultat attendu, le résultat réel et l'impact. Distinguer « exploité », « protection observée », « hypothèse non reproduite » et « non vérifié ». Un test réseau doit mesurer les connexions effectivement tentées ; un test de navigateur doit observer le DOM final, les navigations et les requêtes, pas seulement comparer du HTML sérialisé.

## 2. Authentification, révocation et frontières d'autorisation

OWASP recommande l'invalidation côté serveur, des échéances de session et la réauthentification après des événements à risque. Le navigateur fermé et le cookie effacé ne suffisent pas à invalider un identifiant volé. Pour Pocketmark, distinguer la durée absolue actuelle de sept jours, la révocation effective, l'absence éventuelle d'expiration d'inactivité et le besoin éventuel de redemander le mot de passe avant les opérations sensibles. Ces derniers choix sont des sujets de durcissement à évaluer, pas une exploitation démontrée. [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Corpus proposé à partir de [account.go](../internal/server/account.go), [sessions.go](../internal/store/sessions.go) et [security_test.go](../internal/server/security_test.go) :

| Cas | Preuve attendue |
| --- | --- |
| Connexion concurrente avec changement de mot de passe | Aucune session issue des anciens identifiants n'est enregistrée après le changement. |
| Déconnexion, redémarrage, rejeu du cookie, création de clé | Le cookie révoqué reste inutilisable et ne permet pas de créer une clé persistante. |
| Nouvelle session, expiration, éviction à la limite, rotation du secret serveur | Sessions indépendantes ; effets conformes et persistants ; aucun secret brut en base. |
| Clé nommée, désactivée ou supprimée sur toutes les routes et variantes de méthode | Administration, clés et sauvegarde refusées aux intégrations ; révocation vérifiée aussi en WebDAV. |
| Deux cookies homonymes, Authorization répété, cookie valide avec bearer invalide | Comportement déterministe sans promotion d'une clé limitée en propriétaire. |
| Origin hostile, `null`, absent, extension, sous-domaine, Fetch Metadata | Les mutations de navigateur hostiles échouent ; tester les cas réellement émis par un navigateur. |
| Première installation, base ancienne vide, restauration, deux setups simultanés | Aucun propriétaire créé sans la preuve d'administration ; données et droits historiques préservés. |

## 3. SSRF et contenu distant : contrôler la connexion réelle

OWASP recommande de combiner validation applicative et restrictions réseau, de traiter les adresses privées/locales, les réponses DNS A/AAAA et les redirections. Pocketmark doit accepter des sites Internet arbitraires : une liste de domaines autorisés n'est donc pas adaptée au produit. La propriété à prouver est que chaque connexion utilise une adresse numérique contrôlée et que chaque nouvelle destination repasse les mêmes contrôles. [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Le code [capture.go](../internal/capture/capture.go) désactive le proxy d'environnement et les connexions réutilisées, valide toutes les adresses retournées avant de composer l'adresse de connexion, limite les redirections et borne les octets compressés puis décompressés. [offline.go](../internal/capture/offline.go) est une seconde surface à inclure, car les ressources CSS/images/fontes étendent le graphe de requêtes.

Corpus proposé : réponses DNS mixtes publique/privée et IPv4/IPv6 ; DNS changeant entre deux appels ; loopback, link-local, metadata, IPv4 mappée, zone IPv6, adresses de transition/NAT64 ; URL avec userinfo, fragment trompeur, port inhabituel, encodages et point terminal ; redirection vers une destination interdite ; URL relative et `base` ; ressource indirecte CSS ; variables `HTTP_PROXY`/`HTTPS_PROXY` définies ; gzip concaténé, tronqué, gros taux d'expansion et réponse chunked. Utiliser résolveur et dialer simulés avec compteurs, ou serveurs jetables. Pour un refus, exiger **zéro connexion vers la destination interdite** ; pour la décompression, vérifier mémoire, temps et limite de sortie. Ces cas sont notre corpus dérivé du code et du modèle de menace, pas une liste de vulnérabilités constatées.

## 4. HTML hostile : tester le navigateur après transformation

Le standard HTML précise que le sandbox bloque notamment scripts, formulaires et accès à l'origine selon ses drapeaux, mais que le drapeau de navigation ne bloque pas la navigation de son propre contexte. Le sandbox ne remplace donc pas l'examen des liens. La CSP distingue les directives de ressources de `form-action` ; la présence de `default-src 'none'` ne justifie pas à elle seule une affirmation « aucune navigation ». [HTML, sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing), [CSP, directives de navigation](https://www.w3.org/TR/CSP3/#directives-navigation).

La CSP3 consultée est un **Working Draft daté du 16 septembre 2026**, et HTML un Living Standard. L'implémentation de chaque navigateur doit être mesurée. Dans Pocketmark, tester séparément [Preview](../internal/capture/preview.go), l'URL `/api/assets/{id}/view`, le [shell de prévisualisation](../internal/webui/static/asset-preview.js), le reader et le téléchargement original : leurs garanties diffèrent.

Corpus proposé : `href`/`xlink:href`, doublons et casse, entités HTML, SVG/MathML/`foreignObject`, SMIL, `base`, meta refresh, formulaires et `formaction`, `srcdoc`, `object`, `embed`, CSS `url()`/`@import`, SVG en data URL, balises mal fermées, `noscript`, `template`, rawtext et mutation au reparsing. Essayer un clic réel ainsi que le chargement sans interaction. Vérifier absence d'exécution, de navigation externe, de requête réseau et d'accès au parent/cookies. Ne pas confondre une navigation nécessitant un clic avec une XSS ou une exfiltration prouvée.

## 5. HTTP, disponibilité et proxy

Go distingue délai des en-têtes, délai de lecture totale, délai d'écriture et attente keep-alive ; `MaxHeaderBytes` ne borne pas le corps. `ResponseController.SetReadDeadline` doit traverser les wrappers supportés et ses erreurs ne doivent pas être supposées impossibles. [net/http Server](https://pkg.go.dev/net/http#Server), [source ResponseController](https://go.dev/src/net/http/responsecontroller.go).

Le cadrage HTTP ambigu est une propriété de la **chaîne** proxy/application. RFC 9112 définit notamment le traitement de `Transfer-Encoding` et `Content-Length` et les obligations de fermeture dans certains cas ; tester seulement `httptest.ResponseRecorder` ne valide pas la résistance de l'Ingress au request smuggling. [RFC 9112, section 6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3).

Corpus local proposé : en-têtes lents, corps incomplet, chunked sans fin, `Expect: 100-continue`, `Content-Length` contradictoires, TE+CL, méthode inconnue, chemins encodés/normalisés, déconnexion en cours d'import, client qui ne lit pas un export, connexion réutilisée après timeout de login. Vérifier libération des slots, transactions et fichiers temporaires, disponibilité des sondes **et d'une opération authentifiée**, puis récupération après arrêt de l'essai. Les plafonds de requêtes en cours ne sont pas un plafond global de connexions TCP ou de goroutines.

Pour [login_limit.go](../internal/server/login_limit.go), couvrir XFF répété, chaîne mixte de proxys fiables/non fiables, IPv4 mappée, rotation dans un /64 IPv6, entête trop long/malformé et saturation du nombre de sources. La bonne configuration doit être confrontée au véritable comportement du proxy : qui ajoute XFF, quelle adresse voit l'application, et peut-on contourner l'Ingress ? Un test direct du serveur ne répond pas à ces trois questions.

## 6. Imports, XML, SQLite et sauvegardes

Le contrat d'`encoding/xml.Decoder` expose `Strict`, `Entity`, `Skip` et `DecodeElement` ; les substitutions supplémentaires relèvent de la configuration du décodeur. Ne pas transposer automatiquement une recette XXE d'une autre bibliothèque : vérifier le comportement de la version Go utilisée et du code appelant. [Documentation officielle encoding/xml](https://pkg.go.dev/encoding/xml#Decoder), [source du parseur](https://go.dev/src/encoding/xml/xml.go).

Dans [xbel.go](../internal/store/xbel.go), les dossiers reconnus ont une profondeur bornée, mais les sous-arbres inconnus sont traversés via `Skip` et les textes via `DecodeElement` : tester ces chemins séparément. Ajouter DTD et entités externes/internes, attributs à espaces de noms, doublons d'ID, deux documents successifs, fin tronquée, texte énorme, profondeur et largeur importantes. L'oracle inclut absence d'accès réseau/fichier, consommation bornée et **aucune mutation partielle** de la bibliothèque en cas d'échec.

Pour JSON/HTML, tester profondeur, clés répétées, nombres extrêmes, Unicode invalide, cycles de collections et références incohérentes ; contrôler le rollback et les données conservées. Les limites et contrats proviennent de [API.md](API.md), [import_json.go](../internal/store/import_json.go), [import_html.go](../internal/store/import_html.go) et [ARCHIVES.md](ARCHIVES.md). La sauvegarde [assets.go](../internal/server/assets.go) produit un ZIP ; cela ne prouve pas l'existence d'une extraction ZIP exposée sur le serveur. Ne pas déclarer Zip Slip applicable sans identifier un chemin d'extraction réellement accessible. Tester plutôt l'autorisation de sauvegarde, sa confidentialité et sa restauration sur données jetables, y compris le devenir des sessions restaurées.

## 7. Kubernetes et artefact réellement déployé

Une NetworkPolicy n'est appliquée que par un composant réseau compatible. Les effets de DNAT/SNAT et des Services sur `ipBlock` dépendent de l'implémentation. Il faut donc vérifier le CNI et observer les refus depuis le Pod ; un YAML seul ne prouve pas l'isolation. Proposition Pocketmark : ingress limité au contrôleur autorisé, DNS explicitement permis, egress Internet nécessaire à la capture mais exclusion effective des réseaux privés, metadata, API Kubernetes et services internes, en IPv4 **et** IPv6. [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

Le profil Pod Security **Restricted** impose notamment non-root, absence d'escalade, seccomp autorisé et retrait des capacités. Compléter pour Pocketmark par système de fichiers racine en lecture seule et volumes d'écriture bornés. Ce complément est une proposition d'exploitation, pas une propriété entièrement couverte par Restricted. [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).

Ne pas monter de token ServiceAccount sans besoin ; vérifier les droits RBAC, permissions du volume et des secrets, limites de ressources, sauvegardes privées et restauration. Pinner le digest d'image et scanner l'image réellement exécutée, y compris les composants système/CGO. Ces contrôles concordent avec la [checklist Kubernetes officielle](https://kubernetes.io/docs/concepts/security/security-checklist/). Aucun résultat de cette recherche ne valide le cluster inconnu.

`govulncheck` utilise l'analyse d'atteignabilité pour les vulnérabilités Go connues ; son résultat dépend de la base, de la toolchain et des build tags. Il ne remplace pas un scan de l'image ni la recherche de failles métier. [Gestion des vulnérabilités Go](https://go.dev/doc/security/vuln/). Une attestation relie l'artefact au processus/source de build, et son bénéfice nécessite une vérification : elle ne certifie pas l'absence de faille. [Attestations GitHub](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

## 8. Exécution proportionnée et critères de livraison

Ordre proposé : revue des frontières et régressions existantes ; essais HTTP et transactions sur base jetable ; corpus navigateur ; fuzzing court borné ; scans source/dépendances/image ; enfin tests de l'Ingress/CNI dans un environnement de validation. Le fuzzing Go conserve les entrées provoquant des échecs pour les rejouer : utiliser des cibles sans effets externes et conserver les cas minimisés. Un budget court apporte une couverture supplémentaire sans établir l'absence de vulnérabilité. [Go Fuzzing](https://go.dev/doc/security/fuzz/).

ZAP Baseline effectue un crawl puis une analyse passive ; il ne lance pas d'attaques actives. Un résultat propre ne couvre donc pas les courses de révocation, SSRF avec pinning DNS, sandbox de prévisualisation ou rollback WebDAV. L'utiliser éventuellement pour les en-têtes et surfaces accessibles, puis compléter avec les preuves ciblées ci-dessus. [Documentation ZAP Baseline](https://www.zaproxy.org/docs/docker/baseline-scan/).

Avant feu vert, exiger : pas de faille critique/élevée confirmée non traitée ; risques résiduels explicités ; tests du digest prévu ; configuration HTTPS/proxy validée ; isolation réseau réellement observée ; secrets privés ; restauration essayée. En l'absence du cluster, de l'Ingress ou du digest de livraison, le verdict doit rester « préparation applicative évaluée, déploiement non validé ».

## 9. Approfondissement : divergence `noscript` et amplification JSON

### `noscript` : filtre lexical et navigateur ne voient pas les mêmes éléments

L'équipe d'audit rapporte une reproduction dans Chrome 156 : un lien à l'intérieur de `noscript` conserve son `href` après `Preview` et navigue après clic sur l'URL `/view` directe. Le premier essai du shell utilisait une URL relative : son absence de navigation ne suffisait pas à prouver la protection. La régression du correctif utilise une URL absolue et attend le refus réseau par CSP. Cette observation doit être accompagnée des preuves navigateur du rapport ; elle n'a pas été réexécutée pour cette note et ne démontre pas une exécution JavaScript.

L'explication est appuyée par les sources : le tokenizer `x/net/html` v0.61.0 traite `noscript` en rawtext, tandis que son parseur appelle `NextIsNotRawText` lorsque le scripting est désactivé. La documentation avertit qu'un tokenizer seul doit adapter ce comportement au contexte et cite notamment `title` dans SVG. [Source tokenizer v0.61.0](https://github.com/golang/net/blob/v0.61.0/html/token.go), [source parseur v0.61.0](https://github.com/golang/net/blob/v0.61.0/html/parse.go), [contrat NextIsNotRawText](https://pkg.go.dev/golang.org/x/net/html#Tokenizer.NextIsNotRawText).

Le standard HTML conditionne lui aussi le traitement rawtext de `noscript` au scripting ; le sandbox sans permission de script désactive celui-ci. Ainsi, le texte brut recopié par le filtre peut devenir des éléments actifs au parsing du navigateur. [Règles de parsing HTML](https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody), [activation du scripting](https://html.spec.whatwg.org/multipage/webappapis.html#enabling-and-disabling-scripting).

Recommandation : corriger la classe de divergence, pas seulement ajouter une expression régulière sur ce payload. Une suppression conservatrice de `noscript` et de son contenu ou l'analyse explicite de ses enfants peut fermer ce cas, mais ne valide pas tous les contextes étrangers. Pour une garantie plus solide, employer une transformation consciente du contexte HTML5 avec politique restrictive et budgets mémoire explicites ; une autre stratégie est de réserver la prévisualisation au shell isolé et de servir les accès directs en téléchargement. Le choix doit préserver les archives originales. Le parseur DOM complet sur 20 MiB doit faire l'objet d'une mesure mémoire avant adoption.

Corpus de régression proposé : `noscript` dans head/body, variantes imbriquées ou mal fermées ; SVG `title`, `desc`, `foreignObject` ; MathML et `annotation-xml` ; `textarea`, `xmp`, `noembed`, `noframes`, CDATA et commentaires ; liens ordinaires/SVG, meta refresh et formulaires dans ces contextes. Vérifier DOM final, clics, navigation et requêtes dans le shell et en accès direct, avec scripts désactivés par la politique réelle.

### Import JSON : compter avant d'allouer

`Decoder.Decode` lit une valeur JSON entière dans son tampon avant de la décoder. Le décodage des tableaux fait croître les slices : une limite d'octets réseau ne correspond donc pas à la même limite en mémoire. [Source encoding/json Decoder](https://go.dev/src/encoding/json/stream.go), [contrat de décodage des slices](https://pkg.go.dev/encoding/json#Unmarshal). OWASP recommande de limiter la taille d'entrée et d'éviter l'allocation de ressources pilotée par l'entrée. [OWASP DoS, validation](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html#input-validation).

Dans la révision auditée `bd2e946` de [import_json.go](../internal/store/import_json.go), `Decode(&data)` précédait les limites de 2 000 collections et 10 000 liens. `PinnedLinks` et les tableaux de tags sont également matérialisés ; `PinnedLinks` ne participe pas au compteur `n`. Le second `Decode(&extra)` alloue encore un document supplémentaire pourtant destiné à être rejeté. La route impose déjà 8 MiB, une seule importation et une authentification : le risque à mesurer concerne donc une amplification mémoire par entrée authentifiée ou fichier importé hostile, pas un DoS anonyme démontré.

Contrôles proposés : plafonds cumulatifs de profondeur, éléments et tags vérifiés avant matérialisation ; comptage des listes imbriquées et `pinnedLinks` ; lecture incrémentale par enregistrement. Si l'ordre des champs et les références imposent deux passes, utiliser un fichier temporaire borné puis une passe de validation avant décodage, en conservant l'atomicité. Éviter de construire un `any` pour refuser les octets non blancs après le premier document, sans oublier les octets déjà tamponnés par le décodeur. Mesurer allocation totale, pic de heap/RSS, latence et rollback sur tableaux d'objets vides, `pinnedLinks`, tags et second document ; aucune valeur de consommation n'est avancée ici avant mesure.

Les corrections et résultats mesurés sont consignés dans [l’audit approfondi](SECURITY_DEEP_AUDIT.md). Cette note distingue les propositions de recherche des vérifications exécutées.
