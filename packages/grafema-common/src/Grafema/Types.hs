{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE StrictData #-}
-- Shared graph types matching Contract B (core-v2/src/types.ts)
-- Extracted from Analysis.Types for reuse by grafema-analyzer and plugins.
module Grafema.Types
  ( GraphNode(..)
  , GraphEdge(..)
  , MetaValue(..)
  , ExportInfo(..)
  , ExportKind(..)
  , metaToJSON
  ) where

import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Aeson (ToJSON(..), FromJSON(..), object, (.=), (.:), (.:?), (.!=), Value(..), withObject, withText)
import qualified Data.Aeson.Key as K
import Data.Scientific (floatingOrInteger)
import qualified Data.Vector as V

-- | Graph Primitives

data GraphNode = GraphNode
  { gnId       :: !Text
  , gnType     :: !Text
  , gnName     :: !Text
  , gnFile     :: !Text
  , gnLine     :: !Int     -- 1-based
  , gnColumn   :: !Int     -- 0-based
  , gnExported :: !Bool
  , gnMetadata :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- | Metadata values -- we support the same types as JSON
data MetaValue
  = MetaText !Text
  | MetaBool !Bool
  | MetaInt  !Int
  | MetaList ![MetaValue]
  | MetaNull
  deriving (Show, Eq)

data GraphEdge = GraphEdge
  { geSource   :: !Text
  , geTarget   :: !Text
  , geType     :: !Text
  , geMetadata :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- | Export Info

data ExportKind = NamedExport | DefaultExport | ReExport
  deriving (Show, Eq)

data ExportInfo = ExportInfo
  { eiName    :: !Text       -- exported name (or "default")
  , eiNodeId  :: !Text       -- semantic ID of the exported node (or "" for star re-exports)
  , eiKind    :: !ExportKind
  , eiSource  :: !(Maybe Text) -- for re-exports: source module specifier
  } deriving (Show, Eq)

-- | ToJSON instances (Contract B output)

instance ToJSON MetaValue where
  toJSON (MetaText t) = toJSON t
  toJSON (MetaBool b) = toJSON b
  toJSON (MetaInt  i) = toJSON i
  toJSON (MetaList l) = toJSON l
  toJSON MetaNull     = Null

metaToJSON :: Map Text MetaValue -> Value
metaToJSON m
  | Map.null m = object []
  | otherwise  = object [ K.fromText k .= v | (k, v) <- Map.toList m ]

instance ToJSON GraphNode where
  toJSON n = object $
    [ "id"       .= gnId n
    , "type"     .= gnType n
    , "name"     .= gnName n
    , "file"     .= gnFile n
    , "line"     .= gnLine n
    , "column"   .= gnColumn n
    , "exported" .= gnExported n
    ] ++
    [ "metadata" .= metaToJSON (gnMetadata n) | not (Map.null (gnMetadata n)) ]

instance ToJSON GraphEdge where
  toJSON e = object $
    [ "src"  .= geSource e
    , "dst"  .= geTarget e
    , "type" .= geType e
    ] ++
    [ "metadata" .= metaToJSON (geMetadata e) | not (Map.null (geMetadata e)) ]

instance ToJSON ExportKind where
  toJSON NamedExport   = toJSON ("named" :: Text)
  toJSON DefaultExport = toJSON ("default" :: Text)
  toJSON ReExport      = toJSON ("reexport" :: Text)

instance ToJSON ExportInfo where
  toJSON e = object $
    [ "name"   .= eiName e
    , "nodeId" .= eiNodeId e
    , "kind"   .= eiKind e
    ] ++
    [ "source" .= s | Just s <- [eiSource e] ]

-- | FromJSON instances (for plugin protocol deserialization)

instance FromJSON MetaValue where
  parseJSON (String t) = pure (MetaText t)
  parseJSON (Bool b)   = pure (MetaBool b)
  parseJSON (Number n) = pure $ case floatingOrInteger n of
    Right i -> MetaInt i
    Left (_ :: Double) -> MetaInt (truncate n)
  parseJSON (Array a)  = MetaList <$> mapM parseJSON (V.toList a)
  parseJSON Null       = pure MetaNull
  parseJSON _          = pure MetaNull

instance FromJSON GraphNode where
  parseJSON = withObject "GraphNode" $ \v -> GraphNode
    <$> v .:  "id"
    <*> v .:  "type"
    <*> v .:  "name"
    <*> v .:  "file"
    <*> v .:  "line"
    <*> v .:  "column"
    <*> v .:  "exported"
    <*> v .:? "metadata" .!= Map.empty

instance FromJSON GraphEdge where
  parseJSON = withObject "GraphEdge" $ \v -> GraphEdge
    <$> v .:  "src"
    <*> v .:  "dst"
    <*> v .:  "type"
    <*> v .:? "metadata" .!= Map.empty

instance FromJSON ExportKind where
  parseJSON = withText "ExportKind" $ \t -> case t of
    "named"    -> pure NamedExport
    "default"  -> pure DefaultExport
    "reexport" -> pure ReExport
    _          -> fail $ "Unknown ExportKind: " ++ show t

instance FromJSON ExportInfo where
  parseJSON = withObject "ExportInfo" $ \v -> ExportInfo
    <$> v .:  "name"
    <*> v .:  "nodeId"
    <*> v .:  "kind"
    <*> v .:? "source"
