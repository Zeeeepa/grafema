{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified ImportResolution
import qualified RuntimeGlobals
import qualified Builtins
import qualified CrossFileCalls
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd   :: Text        -- "imports" | "runtime-globals" | "builtins" | "cross-file-calls"
  , drNodes :: [GraphNode]
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .: "nodes"

-- | Response to orchestrator.
data DaemonResponse
  = ResOk [PluginCommand]
  | ResError String

instance ToJSON DaemonResponse where
  toJSON (ResOk cmds) = object
    [ "status"   .= ("ok" :: Text)
    , "commands" .= cmds
    ]
  toJSON (ResError msg) = object
    [ "status" .= ("error" :: Text)
    , "error"  .= msg
    ]

-- | Daemon loop: read frames from stdin, dispatch, write responses.
daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch (drCmd req) (drNodes req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop

-- | Dispatch a request to the appropriate resolver.
dispatch :: Text -> [GraphNode] -> IO DaemonResponse
dispatch "imports" nodes = ResOk <$> ImportResolution.resolveAll nodes
dispatch "runtime-globals" nodes = return $ ResOk (RuntimeGlobals.resolveAll nodes)
dispatch "builtins" nodes = return $ ResOk (Builtins.resolveAll nodes)
dispatch "cross-file-calls" nodes = return $ ResOk (CrossFileCalls.resolveAll nodes)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | Original CLI subcommand parser.
data Command = CmdImports | CmdRuntimeGlobals | CmdBuiltins | CmdCrossFileCalls

commandParser :: Parser Command
commandParser = subparser
  ( command "imports"
    (info (pure CmdImports) (progDesc "Resolve JS/TS imports across files"))
  <> command "runtime-globals"
    (info (pure CmdRuntimeGlobals) (progDesc "Resolve unresolved references to runtime globals"))
  <> command "builtins"
    (info (pure CmdBuiltins) (progDesc "Resolve Node.js builtin module imports and calls"))
  <> command "cross-file-calls"
    (info (pure CmdCrossFileCalls) (progDesc "Create CALLS edges for cross-file invocations"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Grafema cross-file resolution plugins"
  <> header "grafema-resolve - resolution plugins for the Grafema graph"
  )

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdImports        -> ImportResolution.run
        CmdRuntimeGlobals -> RuntimeGlobals.run
        CmdBuiltins       -> Builtins.run
        CmdCrossFileCalls -> CrossFileCalls.run
