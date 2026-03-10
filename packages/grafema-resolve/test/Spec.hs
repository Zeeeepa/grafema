{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import qualified Data.Map.Strict as Map
import Data.Text (Text)
import System.Exit (exitFailure, exitSuccess)
import System.IO (hPutStrLn, stderr)

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified PropertyAccess

-- ---------------------------------------------------------------------------
-- Test helpers
-- ---------------------------------------------------------------------------

-- | Create a minimal GraphNode with defaults for unused fields.
mkNode :: Text -> Text -> Text -> Text -> Map.Map Text MetaValue -> GraphNode
mkNode nid ntype name file meta = GraphNode
  { gnId        = nid
  , gnType      = ntype
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 1
  , gnEndColumn = 0
  , gnExported  = False
  , gnMetadata  = meta
  }

-- | Create an IMPORT_BINDING node for a namespace import (import * as X).
mkNamespaceImportBinding :: Text -> Text -> Text -> GraphNode
mkNamespaceImportBinding file localName source =
  mkNode
    (file <> "->IMPORT_BINDING->" <> localName <> "[in:" <> source <> "]")
    "IMPORT_BINDING"
    localName
    file
    (Map.fromList
      [ ("source", MetaText source)
      , ("importedName", MetaText "*")
      ])

-- | Create an IMPORT_BINDING node for a named import (import { X } from '...').
mkNamedImportBinding :: Text -> Text -> Text -> Text -> GraphNode
mkNamedImportBinding file localName importedName source =
  mkNode
    (file <> "->IMPORT_BINDING->" <> localName <> "[in:" <> source <> "]")
    "IMPORT_BINDING"
    localName
    file
    (Map.fromList
      [ ("source", MetaText source)
      , ("importedName", MetaText importedName)
      ])

-- | Create a PROPERTY_ACCESS node.
mkPropertyAccess :: Text -> Text -> Text -> GraphNode
mkPropertyAccess file name nid =
  mkNode nid "PROPERTY_ACCESS" name file Map.empty

-- | Create an exported FUNCTION node.
mkExportedFunction :: Text -> Text -> GraphNode
mkExportedFunction file name =
  (mkNode (file <> "->FUNCTION->" <> name) "FUNCTION" name file Map.empty)
    { gnExported = True }

-- | Create an exported VARIABLE node.
mkExportedVariable :: Text -> Text -> GraphNode
mkExportedVariable file name =
  (mkNode (file <> "->VARIABLE->" <> name) "VARIABLE" name file Map.empty)
    { gnExported = True }

-- | Extract edges from plugin commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap getEdge
  where
    getEdge (EmitEdge e) = [e]
    getEdge _            = []

-- ---------------------------------------------------------------------------
-- Test runner
-- ---------------------------------------------------------------------------

data TestResult = Pass | Fail String

runTest :: String -> TestResult -> IO Bool
runTest name Pass = do
  putStrLn $ "  PASS: " ++ name
  return True
runTest name (Fail msg) = do
  hPutStrLn stderr $ "  FAIL: " ++ name ++ " -- " ++ msg
  return False

-- ---------------------------------------------------------------------------
-- Tests
-- ---------------------------------------------------------------------------

-- | Namespace import: utils.greet -> READS_FROM to exported greet function
testNamespaceImport :: TestResult
testNamespaceImport =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkPropertyAccess appFile "utils.greet"
            (appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geSource e == appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]"
        , geTarget e == utilsFile <> "->FUNCTION->greet"
        , geType e == "READS_FROM"
        , Map.lookup "resolvedVia" (geMetadata e) == Just (MetaText "property-access")
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge, got: " ++ show edges

-- | Named import (config.port) -> no edges (V1 skips)
testNamedImportSkipped :: TestResult
testNamedImportSkipped =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamedImportBinding appFile "config" "config" "./utils"
        , mkExportedVariable utilsFile "config"
        , mkPropertyAccess appFile "config.port"
            (appFile <> "->PROPERTY_ACCESS->config.port[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for named import, got: " ++ show edges

-- | Chained access (ns.foo.bar) -> no edges for the chained node (V1 skips)
testChainedAccessSkipped :: TestResult
testChainedAccessSkipped =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "ns" "./utils"
        , mkExportedVariable utilsFile "foo"
        -- The chained PROPERTY_ACCESS node: ns.foo.bar
        -- T.breakOn "." "ns.foo.bar" gives objectName="ns", propertyName="foo.bar"
        -- "foo.bar" won't match any export
        , mkPropertyAccess appFile "ns.foo.bar"
            (appFile <> "->PROPERTY_ACCESS->ns.foo.bar[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for chained access, got: " ++ show edges

-- | Non-import variable access -> no edges
testNonImportAccessSkipped :: TestResult
testNonImportAccessSkipped =
  let appFile = "src/app.ts"
      nodes =
        [ mkPropertyAccess appFile "localVar.prop"
            (appFile <> "->PROPERTY_ACCESS->localVar.prop[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for non-import access, got: " ++ show edges

-- | Computed property (no dot in name) -> no edges
testNoDotSkipped :: TestResult
testNoDotSkipped =
  let appFile = "src/app.ts"
      nodes =
        [ mkPropertyAccess appFile "computedProp"
            (appFile <> "->PROPERTY_ACCESS->computedProp[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for no-dot name, got: " ++ show edges

-- | Multiple namespace accesses from same import -> multiple READS_FROM edges
testMultipleAccesses :: TestResult
testMultipleAccesses =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkExportedFunction utilsFile "farewell"
        , mkPropertyAccess appFile "utils.greet"
            (appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]")
        , mkPropertyAccess appFile "utils.farewell"
            (appFile <> "->PROPERTY_ACCESS->utils.farewell[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e1, e2]
      | geTarget e1 == utilsFile <> "->FUNCTION->greet"
      , geTarget e2 == utilsFile <> "->FUNCTION->farewell"
      -> Pass
    _ -> Fail $ "Expected 2 READS_FROM edges, got: " ++ show edges

-- | Empty nodes list -> no crash, no edges
testEmptyNodes :: TestResult
testEmptyNodes =
  let cmds = PropertyAccess.resolveAll []
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for empty input, got: " ++ show edges

-- | Property access to non-existent export -> no edges
testNonExistentExport :: TestResult
testNonExistentExport =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkPropertyAccess appFile "utils.nonExistent"
            (appFile <> "->PROPERTY_ACCESS->utils.nonExistent[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for non-existent export, got: " ++ show edges

-- ---------------------------------------------------------------------------
-- Main
-- ---------------------------------------------------------------------------

main :: IO ()
main = do
  putStrLn "PropertyAccess unit tests:"
  results <- sequence
    [ runTest "namespace import resolves to READS_FROM" testNamespaceImport
    , runTest "named import skipped (V1)" testNamedImportSkipped
    , runTest "chained access skipped (V1)" testChainedAccessSkipped
    , runTest "non-import access skipped" testNonImportAccessSkipped
    , runTest "no dot in name skipped" testNoDotSkipped
    , runTest "multiple accesses from same import" testMultipleAccesses
    , runTest "empty nodes no crash" testEmptyNodes
    , runTest "non-existent export no edge" testNonExistentExport
    ]
  let total = length results
      passed = length (filter id results)
  putStrLn $ show passed ++ "/" ++ show total ++ " tests passed"
  if all id results then exitSuccess else exitFailure
