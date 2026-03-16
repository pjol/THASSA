package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/pjol/THASSA/node/internal/autofill"
	"github.com/pjol/THASSA/node/internal/config"
	"github.com/pjol/THASSA/node/internal/format"
	"github.com/pjol/THASSA/node/internal/openai"
	"github.com/pjol/THASSA/node/internal/server"
	"github.com/pjol/THASSA/node/internal/signing"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	signer, err := signing.NewSigner(cfg.NodePrivateKey)
	if err != nil {
		log.Fatalf("create signer: %v", err)
	}

	openAITimeout := cfg.RequestTimeout
	if cfg.AutoFulfillLLMTimeout > openAITimeout {
		openAITimeout = cfg.AutoFulfillLLMTimeout
	}

	openAIClient := openai.NewClient(
		cfg.OpenAIAPIKey,
		cfg.OpenAIBaseURL,
		openAITimeout,
		cfg.OpenAIMaxContextChars,
	)
	formatter := format.NewABIFormatter()

	if cfg.AutoFulfillBids {
		worker, err := autofill.New(cfg, openAIClient, formatter, signer)
		if err != nil {
			log.Fatalf("create auto-fulfill worker: %v", err)
		}

		go worker.Start(context.Background())
	}

	handler := server.New(cfg, openAIClient, formatter, signer).Handler()

	httpServer := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("thassa node demo server listening on :%s", cfg.Port)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
