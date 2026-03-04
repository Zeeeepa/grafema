{-# LANGUAGE OverloadedStrings #-}
-- | Node.js builtins resolution plugin.
--
-- Resolves IMPORT_BINDING nodes whose source is a Node.js builtin module
-- (e.g., 'fs', 'path', 'node:crypto'). For each match, emits virtual
-- EXTERNAL_MODULE and EXTERNAL_FUNCTION nodes plus IMPORTS_FROM and CALLS edges.
--
-- Handles both namespace/default imports (@import fs from 'fs'; fs.readFileSync()@)
-- and named imports (@import { join } from 'path'; join()@).
module Builtins (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- ---------------------------------------------------------------------------
-- Builtin function definition
-- ---------------------------------------------------------------------------

data BuiltinFunc = BuiltinFunc
  { bfName     :: !Text          -- "readFile", "join"
  , bfSecurity :: !(Maybe Text)  -- "file-io" | "exec" | "net" | "crypto"
  , bfPure     :: !Bool
  }

-- | Helper to build a BuiltinFunc.
mkFunc :: Text -> Maybe Text -> Bool -> BuiltinFunc
mkFunc = BuiltinFunc

-- | A builtin module with its known functions.
data BuiltinModule = BuiltinModule
  { bmName  :: !Text             -- "fs", "path", etc.
  , bmFuncs :: ![BuiltinFunc]
  }

-- ---------------------------------------------------------------------------
-- Builtin module registry (ported from core/src/data/builtins/definitions.ts)
-- ---------------------------------------------------------------------------

-- | All known Node.js builtin module names (for quick membership check).
builtinModuleNames :: Set Text
builtinModuleNames = Set.fromList $ map bmName allBuiltinModules

-- | Check if a module specifier refers to a Node.js builtin.
-- Handles both bare names ("fs") and node: prefix ("node:fs").
isBuiltinModule :: Text -> Bool
isBuiltinModule spec =
  let normalized = normalizeModuleName spec
  in Set.member normalized builtinModuleNames

-- | Strip the "node:" prefix if present.
normalizeModuleName :: Text -> Text
normalizeModuleName spec
  | "node:" `T.isPrefixOf` spec = T.drop 5 spec
  | otherwise = spec

-- | Lookup a function in the builtin registry.
-- Returns the BuiltinFunc if the module+function combo is known.
lookupBuiltinFunc :: Text -> Text -> Maybe BuiltinFunc
lookupBuiltinFunc moduleName funcName =
  case Map.lookup moduleName builtinFuncIndex of
    Nothing    -> Nothing
    Just funcs -> Map.lookup funcName funcs

-- | Index: module name -> (function name -> BuiltinFunc)
builtinFuncIndex :: Map Text (Map Text BuiltinFunc)
builtinFuncIndex = Map.fromList
  [ (bmName m, Map.fromList [(bfName f, f) | f <- bmFuncs m])
  | m <- allBuiltinModules
  ]

-- | All builtin modules (Tier 1 + Tier 2).
allBuiltinModules :: [BuiltinModule]
allBuiltinModules =
  -- Tier 1
  [ BuiltinModule "fs"
      [ mkFunc "readFile" (Just "file-io") False
      , mkFunc "readFileSync" (Just "file-io") False
      , mkFunc "writeFile" (Just "file-io") False
      , mkFunc "writeFileSync" (Just "file-io") False
      , mkFunc "appendFile" (Just "file-io") False
      , mkFunc "appendFileSync" (Just "file-io") False
      , mkFunc "readdir" (Just "file-io") False
      , mkFunc "readdirSync" (Just "file-io") False
      , mkFunc "mkdir" (Just "file-io") False
      , mkFunc "mkdirSync" (Just "file-io") False
      , mkFunc "rmdir" (Just "file-io") False
      , mkFunc "rmdirSync" (Just "file-io") False
      , mkFunc "rm" (Just "file-io") False
      , mkFunc "rmSync" (Just "file-io") False
      , mkFunc "unlink" (Just "file-io") False
      , mkFunc "unlinkSync" (Just "file-io") False
      , mkFunc "stat" (Just "file-io") False
      , mkFunc "statSync" (Just "file-io") False
      , mkFunc "lstat" (Just "file-io") False
      , mkFunc "lstatSync" (Just "file-io") False
      , mkFunc "access" (Just "file-io") False
      , mkFunc "accessSync" (Just "file-io") False
      , mkFunc "chmod" (Just "file-io") False
      , mkFunc "chmodSync" (Just "file-io") False
      , mkFunc "chown" (Just "file-io") False
      , mkFunc "chownSync" (Just "file-io") False
      , mkFunc "rename" (Just "file-io") False
      , mkFunc "renameSync" (Just "file-io") False
      , mkFunc "copyFile" (Just "file-io") False
      , mkFunc "copyFileSync" (Just "file-io") False
      , mkFunc "createReadStream" (Just "file-io") False
      , mkFunc "createWriteStream" (Just "file-io") False
      , mkFunc "watch" (Just "file-io") False
      , mkFunc "watchFile" (Just "file-io") False
      , mkFunc "existsSync" (Just "file-io") False
      , mkFunc "truncate" (Just "file-io") False
      , mkFunc "truncateSync" (Just "file-io") False
      ]
  , BuiltinModule "fs/promises"
      [ mkFunc "readFile" (Just "file-io") False
      , mkFunc "writeFile" (Just "file-io") False
      , mkFunc "appendFile" (Just "file-io") False
      , mkFunc "readdir" (Just "file-io") False
      , mkFunc "mkdir" (Just "file-io") False
      , mkFunc "rmdir" (Just "file-io") False
      , mkFunc "rm" (Just "file-io") False
      , mkFunc "unlink" (Just "file-io") False
      , mkFunc "stat" (Just "file-io") False
      , mkFunc "lstat" (Just "file-io") False
      , mkFunc "access" (Just "file-io") False
      , mkFunc "chmod" (Just "file-io") False
      , mkFunc "chown" (Just "file-io") False
      , mkFunc "rename" (Just "file-io") False
      , mkFunc "copyFile" (Just "file-io") False
      , mkFunc "truncate" (Just "file-io") False
      ]
  , BuiltinModule "path"
      [ mkFunc "join" Nothing True
      , mkFunc "resolve" Nothing True
      , mkFunc "normalize" Nothing True
      , mkFunc "basename" Nothing True
      , mkFunc "dirname" Nothing True
      , mkFunc "extname" Nothing True
      , mkFunc "parse" Nothing True
      , mkFunc "format" Nothing True
      , mkFunc "relative" Nothing True
      , mkFunc "isAbsolute" Nothing True
      , mkFunc "sep" Nothing True
      , mkFunc "delimiter" Nothing True
      ]
  , BuiltinModule "http"
      [ mkFunc "createServer" (Just "net") False
      , mkFunc "request" (Just "net") False
      , mkFunc "get" (Just "net") False
      ]
  , BuiltinModule "https"
      [ mkFunc "createServer" (Just "net") False
      , mkFunc "request" (Just "net") False
      , mkFunc "get" (Just "net") False
      ]
  , BuiltinModule "crypto"
      [ mkFunc "createHash" (Just "crypto") False
      , mkFunc "createHmac" (Just "crypto") False
      , mkFunc "createCipher" (Just "crypto") False
      , mkFunc "createDecipher" (Just "crypto") False
      , mkFunc "createCipheriv" (Just "crypto") False
      , mkFunc "createDecipheriv" (Just "crypto") False
      , mkFunc "randomBytes" (Just "crypto") False
      , mkFunc "randomFill" (Just "crypto") False
      , mkFunc "randomFillSync" (Just "crypto") False
      , mkFunc "randomUUID" (Just "crypto") False
      , mkFunc "pbkdf2" (Just "crypto") False
      , mkFunc "pbkdf2Sync" (Just "crypto") False
      , mkFunc "scrypt" (Just "crypto") False
      , mkFunc "scryptSync" (Just "crypto") False
      , mkFunc "generateKey" (Just "crypto") False
      , mkFunc "generateKeyPair" (Just "crypto") False
      , mkFunc "generateKeyPairSync" (Just "crypto") False
      ]
  , BuiltinModule "child_process"
      [ mkFunc "exec" (Just "exec") False
      , mkFunc "execSync" (Just "exec") False
      , mkFunc "execFile" (Just "exec") False
      , mkFunc "execFileSync" (Just "exec") False
      , mkFunc "spawn" (Just "exec") False
      , mkFunc "spawnSync" (Just "exec") False
      , mkFunc "fork" (Just "exec") False
      ]
  -- Tier 2
  , BuiltinModule "url"
      [ mkFunc "parse" Nothing True
      , mkFunc "format" Nothing True
      , mkFunc "resolve" Nothing True
      , mkFunc "fileURLToPath" Nothing True
      , mkFunc "pathToFileURL" Nothing True
      ]
  , BuiltinModule "util"
      [ mkFunc "promisify" Nothing True
      , mkFunc "callbackify" Nothing True
      , mkFunc "inspect" Nothing True
      , mkFunc "format" Nothing True
      , mkFunc "deprecate" Nothing False
      , mkFunc "inherits" Nothing False
      ]
  , BuiltinModule "os"
      [ mkFunc "platform" Nothing True
      , mkFunc "arch" Nothing True
      , mkFunc "cpus" Nothing False
      , mkFunc "hostname" Nothing False
      , mkFunc "homedir" Nothing False
      , mkFunc "tmpdir" Nothing False
      , mkFunc "type" Nothing True
      , mkFunc "release" Nothing True
      , mkFunc "totalmem" Nothing False
      , mkFunc "freemem" Nothing False
      ]
  , BuiltinModule "events"
      [ mkFunc "EventEmitter" Nothing False
      , mkFunc "once" Nothing False
      , mkFunc "on" Nothing False
      ]
  , BuiltinModule "stream"
      [ mkFunc "Readable" Nothing False
      , mkFunc "Writable" Nothing False
      , mkFunc "Duplex" Nothing False
      , mkFunc "Transform" Nothing False
      , mkFunc "pipeline" Nothing False
      , mkFunc "finished" Nothing False
      ]
  , BuiltinModule "buffer"
      [ mkFunc "Buffer" Nothing False
      , mkFunc "alloc" Nothing True
      , mkFunc "allocUnsafe" Nothing True
      , mkFunc "from" Nothing True
      , mkFunc "concat" Nothing True
      , mkFunc "isBuffer" Nothing True
      ]
  , BuiltinModule "worker_threads"
      [ mkFunc "Worker" Nothing False
      , mkFunc "isMainThread" Nothing True
      , mkFunc "parentPort" Nothing False
      , mkFunc "workerData" Nothing False
      ]
  ]

-- ---------------------------------------------------------------------------
-- Import index: maps (file, localName) -> (moduleName, importedName)
-- ---------------------------------------------------------------------------

-- | An entry recording that in a given file, a local name maps to a builtin.
data BuiltinImport = BuiltinImport
  { biModule       :: !Text  -- normalized module name ("fs", "path")
  , biImportedName :: !Text  -- "default", "*", or specific name ("join")
  }

-- | Index: (file, localName) -> BuiltinImport
type BuiltinImportIndex = Map (Text, Text) BuiltinImport

-- | Build the builtin import index from IMPORT_BINDING nodes.
buildBuiltinImportIndex :: [GraphNode] -> BuiltinImportIndex
buildBuiltinImportIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), BuiltinImport normalized importedName)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    , Just source <- [lookupMetaText "source" (gnMetadata n)]
    , let normalized = normalizeModuleName source
    , isBuiltinModule source
    , Just importedName <- [lookupMetaText "importedName" (gnMetadata n)]
    ]

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Accumulator: emitted nodes, emitted edges, set of already-emitted node IDs.
type ResolveAcc = ([GraphNode], [GraphEdge], Set Text)

-- | Core builtins resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let importIndex = buildBuiltinImportIndex nodes
      -- Phase 1: emit EXTERNAL_MODULE nodes + IMPORTS_FROM edges for builtin imports
      importNodes = filter (\n -> gnType n == "IMPORT") nodes
      (modNodes, modEdges, seenMods) = foldl (resolveImportNode importIndex) ([], [], Set.empty) importNodes
      -- Phase 2: emit EXTERNAL_FUNCTION nodes + CALLS edges for calls to builtins
      callNodes = filter (\n -> gnType n == "CALL") nodes
      (funcNodes, callEdges, _) = foldl (resolveCallNode importIndex) ([], [], seenMods) callNodes
  in map EmitNode (modNodes ++ funcNodes) ++ map EmitEdge (modEdges ++ callEdges)

-- | Phase 1: For each IMPORT node with a builtin source, emit EXTERNAL_MODULE + IMPORTS_FROM.
resolveImportNode :: BuiltinImportIndex -> ResolveAcc -> GraphNode -> ResolveAcc
resolveImportNode _importIndex (nodes, edges, seen) importNode =
  let source = gnName importNode  -- IMPORT node name is the source specifier
      normalized = normalizeModuleName source
  in if not (isBuiltinModule source)
     then (nodes, edges, seen)
     else
       let moduleNodeId = "EXTERNAL_MODULE:" <> normalized
           -- Emit module node (deduplicated)
           (nodes', seen') =
             if Set.member moduleNodeId seen
               then (nodes, seen)
               else (nodes ++ [mkExternalModuleNode normalized], Set.insert moduleNodeId seen)
           -- Emit IMPORTS_FROM edge
           edge = GraphEdge
             { geSource   = gnId importNode
             , geTarget   = moduleNodeId
             , geType     = "IMPORTS_FROM"
             , geMetadata = Map.singleton "resolvedVia" (MetaText "builtins")
             }
       in (nodes', edges ++ [edge], seen')

-- | Phase 2: For each CALL node, check if the callee is a builtin import.
resolveCallNode :: BuiltinImportIndex -> ResolveAcc -> GraphNode -> ResolveAcc
resolveCallNode importIndex (nodes, edges, seen) callNode =
  let file = gnFile callNode
      callee = gnName callNode
  in case resolveCallee importIndex file callee of
    Nothing -> (nodes, edges, seen)
    Just (moduleName, funcName) ->
      let funcNodeId = "EXTERNAL_FUNCTION:" <> moduleName <> "." <> funcName
          -- Look up metadata from builtin registry
          mBuiltin = lookupBuiltinFunc moduleName funcName
          -- Emit EXTERNAL_FUNCTION node (deduplicated)
          (nodes', seen') =
            if Set.member funcNodeId seen
              then (nodes, seen)
              else (nodes ++ [mkExternalFuncNode moduleName funcName mBuiltin], Set.insert funcNodeId seen)
          -- Emit CALLS edge
          edge = GraphEdge
            { geSource   = gnId callNode
            , geTarget   = funcNodeId
            , geType     = "CALLS"
            , geMetadata = Map.singleton "resolvedVia" (MetaText "builtins")
            }
      in (nodes', edges ++ [edge], seen')

-- | Resolve a callee name against the builtin import index.
-- Returns (moduleName, functionName) if matched.
resolveCallee :: BuiltinImportIndex -> Text -> Text -> Maybe (Text, Text)
resolveCallee importIndex file callee =
  case T.breakOn "." callee of
    -- Method call: "fs.readFileSync" -> objectName="fs", methodName="readFileSync"
    (objectName, rest)
      | not (T.null rest) ->
          let methodName = T.drop 1 rest  -- drop the "."
          in case Map.lookup (file, objectName) importIndex of
            Just bi -> Just (biModule bi, methodName)
            Nothing -> Nothing
    -- Direct call: "join" -> look up as-is
      | otherwise ->
          case Map.lookup (file, callee) importIndex of
            Just bi -> Just (biModule bi, biImportedName bi)
            Nothing -> Nothing

-- ---------------------------------------------------------------------------
-- Node construction
-- ---------------------------------------------------------------------------

-- | Create an EXTERNAL_MODULE node.
mkExternalModuleNode :: Text -> GraphNode
mkExternalModuleNode moduleName = GraphNode
  { gnId        = "EXTERNAL_MODULE:" <> moduleName
  , gnType      = "EXTERNAL_MODULE"
  , gnName      = moduleName
  , gnFile      = "<builtin>"
  , gnLine      = 0
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = Map.singleton "source" (MetaText "nodejs-builtin")
  }

-- | Create an EXTERNAL_FUNCTION node with optional security/pure metadata.
mkExternalFuncNode :: Text -> Text -> Maybe BuiltinFunc -> GraphNode
mkExternalFuncNode moduleName funcName mBuiltin = GraphNode
  { gnId        = "EXTERNAL_FUNCTION:" <> moduleName <> "." <> funcName
  , gnType      = "EXTERNAL_FUNCTION"
  , gnName      = funcName
  , gnFile      = "<builtin>"
  , gnLine      = 0
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = Map.fromList $ concat
      [ [("module", MetaText moduleName)]
      , [("security", MetaText sec) | Just bf <- [mBuiltin], Just sec <- [bfSecurity bf]]
      , [("pure", MetaBool (bfPure bf)) | Just bf <- [mBuiltin]]
      ]
  }

-- ---------------------------------------------------------------------------
-- Metadata helpers
-- ---------------------------------------------------------------------------

-- | Look up a text value in metadata.
lookupMetaText :: Text -> Map Text MetaValue -> Maybe Text
lookupMetaText key meta = case Map.lookup key meta of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
