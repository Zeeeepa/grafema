{-# LANGUAGE OverloadedStrings #-}
-- | Runtime globals resolution plugin.
--
-- Resolves unresolved REFERENCE nodes against a static database of known
-- runtime globals (Node.js, Browser APIs, ECMAScript builtins).
-- For each match, emits a virtual GLOBAL_DEFINITION node and a RESOLVES_TO edge.
module RuntimeGlobals (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- | Category of a runtime global.
data GlobalCategory = NodeJs | Browser | EcmaScript
  deriving (Show, Eq)

-- | Definition of a known runtime global.
data GlobalDef = GlobalDef
  { gdName     :: !Text
  , gdCategory :: !GlobalCategory
  , gdKind     :: !Text  -- "function" | "object" | "class" | "constant"
  }

-- | Render a category as a stable text identifier.
showCategory :: GlobalCategory -> Text
showCategory NodeJs     = "nodejs"
showCategory Browser    = "browser"
showCategory EcmaScript = "ecmascript"

-- | Build a GlobalDef helper.
mkGlobal :: Text -> GlobalCategory -> Text -> (Text, GlobalDef)
mkGlobal name cat kind = (name, GlobalDef name cat kind)

-- | Static database of known runtime globals, keyed by name.
globalsDb :: Map Text GlobalDef
globalsDb = Map.fromList $ concat [nodejsGlobals, browserGlobals, ecmaScriptGlobals]
  where
    nodejsGlobals =
      [ mkGlobal "console"             NodeJs "object"
      , mkGlobal "process"             NodeJs "object"
      , mkGlobal "Buffer"              NodeJs "class"
      , mkGlobal "__dirname"           NodeJs "constant"
      , mkGlobal "__filename"          NodeJs "constant"
      , mkGlobal "module"              NodeJs "object"
      , mkGlobal "exports"             NodeJs "object"
      , mkGlobal "require"             NodeJs "function"
      , mkGlobal "global"              NodeJs "object"
      , mkGlobal "setTimeout"          NodeJs "function"
      , mkGlobal "setInterval"         NodeJs "function"
      , mkGlobal "setImmediate"        NodeJs "function"
      , mkGlobal "clearTimeout"        NodeJs "function"
      , mkGlobal "clearInterval"       NodeJs "function"
      , mkGlobal "clearImmediate"      NodeJs "function"
      , mkGlobal "queueMicrotask"      NodeJs "function"
      ]

    browserGlobals =
      [ mkGlobal "window"                  Browser "object"
      , mkGlobal "document"                Browser "object"
      , mkGlobal "navigator"               Browser "object"
      , mkGlobal "location"                Browser "object"
      , mkGlobal "history"                 Browser "object"
      , mkGlobal "localStorage"            Browser "object"
      , mkGlobal "sessionStorage"          Browser "object"
      , mkGlobal "fetch"                   Browser "function"
      , mkGlobal "XMLHttpRequest"          Browser "class"
      , mkGlobal "WebSocket"               Browser "class"
      , mkGlobal "requestAnimationFrame"   Browser "function"
      , mkGlobal "cancelAnimationFrame"    Browser "function"
      , mkGlobal "alert"                   Browser "function"
      , mkGlobal "confirm"                 Browser "function"
      , mkGlobal "prompt"                  Browser "function"
      ]

    ecmaScriptGlobals =
      [ mkGlobal "JSON"                    EcmaScript "object"
      , mkGlobal "Math"                    EcmaScript "object"
      , mkGlobal "Date"                    EcmaScript "class"
      , mkGlobal "Promise"                 EcmaScript "class"
      , mkGlobal "Array"                   EcmaScript "class"
      , mkGlobal "Object"                  EcmaScript "class"
      , mkGlobal "String"                  EcmaScript "class"
      , mkGlobal "Number"                  EcmaScript "class"
      , mkGlobal "Boolean"                 EcmaScript "class"
      , mkGlobal "Symbol"                  EcmaScript "class"
      , mkGlobal "Map"                     EcmaScript "class"
      , mkGlobal "Set"                     EcmaScript "class"
      , mkGlobal "WeakMap"                 EcmaScript "class"
      , mkGlobal "WeakSet"                 EcmaScript "class"
      , mkGlobal "Proxy"                   EcmaScript "class"
      , mkGlobal "Reflect"                 EcmaScript "object"
      , mkGlobal "Error"                   EcmaScript "class"
      , mkGlobal "TypeError"               EcmaScript "class"
      , mkGlobal "RangeError"              EcmaScript "class"
      , mkGlobal "ReferenceError"          EcmaScript "class"
      , mkGlobal "SyntaxError"             EcmaScript "class"
      , mkGlobal "RegExp"                  EcmaScript "class"
      , mkGlobal "parseInt"                EcmaScript "function"
      , mkGlobal "parseFloat"              EcmaScript "function"
      , mkGlobal "isNaN"                   EcmaScript "function"
      , mkGlobal "isFinite"                EcmaScript "function"
      , mkGlobal "encodeURIComponent"      EcmaScript "function"
      , mkGlobal "decodeURIComponent"      EcmaScript "function"
      , mkGlobal "encodeURI"               EcmaScript "function"
      , mkGlobal "decodeURI"               EcmaScript "function"
      , mkGlobal "undefined"               EcmaScript "constant"
      , mkGlobal "NaN"                     EcmaScript "constant"
      , mkGlobal "Infinity"                EcmaScript "constant"
      ]

-- | Check if a node is an unresolved reference.
-- A node is unresolved when its type is "REFERENCE" and its metadata
-- contains @resolved = MetaBool False@. Nodes without a @resolved@ field
-- are NOT considered unresolved (conservative: don't claim to resolve
-- something we don't know the status of).
isUnresolved :: GraphNode -> Bool
isUnresolved n =
  gnType n == "REFERENCE" &&
  Map.lookup "resolved" (gnMetadata n) == Just (MetaBool False)

-- | Build a virtual GLOBAL_DEFINITION node for a matched global.
mkGlobalNode :: GlobalDef -> GraphNode
mkGlobalNode def = GraphNode
  { gnId       = "GLOBAL::" <> gdName def
  , gnType     = "GLOBAL_DEFINITION"
  , gnName     = gdName def
  , gnFile     = "<runtime>"
  , gnLine     = 0
  , gnColumn   = 0
  , gnExported = True
  , gnMetadata = Map.fromList
      [ ("category", MetaText (showCategory (gdCategory def)))
      , ("kind",     MetaText (gdKind def))
      ]
  }

-- | Build a RESOLVES_TO edge from a reference node to a global definition.
mkResolvesEdge :: GraphNode -> GlobalDef -> GraphEdge
mkResolvesEdge refNode def = GraphEdge
  { geSource   = gnId refNode
  , geTarget   = "GLOBAL::" <> gdName def
  , geType     = "RESOLVES_TO"
  , geMetadata = Map.fromList
      [ ("resolvedVia",    MetaText "runtime-globals")
      , ("globalCategory", MetaText (showCategory (gdCategory def)))
      ]
  }

-- | Accumulator for the fold: emitted global nodes, emitted edges, and
-- the set of global names already seen (for deduplication).
type ResolveAcc = ([GraphNode], [GraphEdge], Set Text)

-- | Try to resolve a single unresolved reference against the globals database.
-- If matched, emit the GLOBAL_DEFINITION node (deduplicated) and a RESOLVES_TO edge.
resolveRef :: ResolveAcc -> GraphNode -> ResolveAcc
resolveRef (nodes, edges, seen) refNode =
  case Map.lookup (gnName refNode) globalsDb of
    Nothing  -> (nodes, edges, seen)
    Just def ->
      let name   = gdName def
          edge   = mkResolvesEdge refNode def
          -- Only emit the global node once per unique global name
          (nodes', seen') =
            if Set.member name seen
              then (nodes, seen)
              else (nodes ++ [mkGlobalNode def], Set.insert name seen)
      in (nodes', edges ++ [edge], seen')

-- | Core runtime globals resolution, operating on a list of nodes.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let unresolvedRefs = filter isUnresolved nodes
      (globalNodes, edges, _seen) = foldl resolveRef ([], [], Set.empty) unresolvedRefs
  in map EmitNode globalNodes ++ map EmitEdge edges

-- | Entry point: read nodes from stdin, resolve unresolved references
-- against the runtime globals database, and emit results.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
